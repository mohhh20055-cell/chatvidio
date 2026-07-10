// ============================================================
// مسارات البث المباشر - Stream Routes
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

// دالة مساعدة لحماية HTML
function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// ✅ بدء البث باستخدام Jitsi Meet (مع التحقق من عدم وجود بث نشط)
// ============================================================

router.post('/start-jitsi-stream', authenticate, authorize(['teacher']), checkNoActiveStream, [
    body('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id } = req.body;
        
        // ✅ التحقق من أن العرض مملوك للأستاذ
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }
        
        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك ببدء هذا البث' });
        }

        if (offer.status === 'live' || offer.status === 'teacher_ready') {
            return res.status(400).json({ success: false, error: 'هذا العرض قيد البث بالفعل' });
        }

        // ✅ إنشاء غرفة Jitsi
        const roomName = `zoomdz_${offer_id}_${Date.now()}`;
        const password = crypto.randomBytes(6).toString('hex').toUpperCase();
        const roomUrl = `https://meet.jit.si/${roomName}`;
        
        // ✅ حفظ بيانات البث في جدول العروض
        await supabase
            .from('offers')
            .update({
                stream_url: roomUrl,
                stream_platform: 'jitsi',
                status: 'live',
                room_name: roomName,
                room_password: password
            })
            .eq('id', offer_id);
        
        // ✅ جلب الطلاب المسجلين والمدفوعين
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id, payment_amount')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');
        
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

            // ✅ إرسال إشعارات للطلاب
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
        }
        
        res.json({
            success: true,
            room_url: roomUrl,
            password: password,
            room_name: roomName,
            duration: offer.duration,
            students_count: sessions?.length || 0,
            message: 'تم بدء البث بنجاح (مجاني 100%)'
        });
    } catch (error) {
        console.error('❌ خطأ في بدء البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ إيقاف البث مؤقتاً (مع التحقق من ملكية العرض)
// ============================================================

router.post('/pause/:offer_id', authenticate, authorize(['teacher']), validateOfferOwnership, [
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

        // ✅ req.offer متاح من validateOfferOwnership
        const offer = req.offer;

        if (offer.status !== 'live') {
            return res.status(400).json({ success: false, error: 'البث غير نشط' });
        }

        // ✅ تغيير الحالة إلى paused
        await supabase
            .from('offers')
            .update({ status: 'paused' })
            .eq('id', offer_id);

        // ✅ إرسال إشعار للطلاب
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
            duration: offer.duration
        });
    } catch (error) {
        console.error('❌ خطأ في إيقاف البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ استئناف البث (مع التحقق من ملكية العرض)
// ============================================================

router.post('/resume/:offer_id', authenticate, authorize(['teacher']), validateOfferOwnership, [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const offer = req.offer;

        if (offer.status !== 'paused') {
            return res.status(400).json({ success: false, error: 'البث ليس في حالة توقف مؤقت' });
        }

        // ✅ استئناف البث
        await supabase
            .from('offers')
            .update({ status: 'live' })
            .eq('id', offer_id);

        // ✅ إرسال إشعار للطلاب
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
            duration: offer.duration
        });
    } catch (error) {
        console.error('❌ خطأ في استئناف البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ إنهاء البث (مع تحويل الرصيد المعلق)
// ============================================================

router.post('/end/:offer_id', authenticate, authorize(['teacher']), validateOfferOwnership, [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const offer = req.offer;

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
        const percentage = Math.min(1, Math.max(0, actualSeconds / totalSeconds));

        // ✅ تحويل الجلسات إلى مدفوعة وإضافة المبلغ للرصيد
        for (const session of sessions) {
            const amount = session.payment_amount || 0;
            const earnedAmount = Math.round(amount * percentage);
            
            await supabase
                .from('sessions')
                .update({
                    payment_status: 'paid',
                    teacher_earned: earnedAmount,
                    completed_at: new Date().toISOString(),
                    pending_balance: 0
                })
                .eq('id', session.id);

            totalEarned += earnedAmount;
        }

        // ✅ تحديث رصيد الأستاذ
        if (teacher && totalEarned > 0) {
            await supabase
                .from('teachers')
                .update({
                    balance: (teacher.balance || 0) + totalEarned,
                    total_earned: (teacher.total_earned || 0) + totalEarned,
                    pending_withdraw: Math.max(0, (teacher.pending_withdraw || 0) - totalEarned)
                })
                .eq('id', offer.teacher_id);
        }

        // ✅ تحديث حالة العرض إلى completed
        await supabase
            .from('offers')
            .update({
                status: 'completed'
            })
            .eq('id', offer_id);

        // ✅ حذف الجلسات النشطة
        await supabase.from('active_stream').delete().eq('offer_id', offer_id);
        await supabase.from('waiting_room').delete().eq('offer_id', offer_id);

        // ✅ إرسال إشعار للطلاب
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
        console.error('خطأ في جلب حالة البث:', error.message);
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

        // جلب بيانات العرض
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.json({ can_join: false, error: 'العرض غير موجود' });
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

        res.json({
            can_join: isActive && isInStream,
            is_waiting: isActive && !isInStream,
            is_paused: isPaused,
            stream_url: offer.stream_url || null,
            room_password: offer.room_password || null,
            duration: offer.duration || 0,
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
// ✅ إضافة جميع الطلاب إلى البث (مع التحقق من ملكية العرض)
// ============================================================

router.post('/add-all-students/:offer_id', authenticate, authorize(['teacher']), validateOfferOwnership, [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const offer = req.offer;

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
            await insert('notifications', {
                user_id: studentId,
                user_type: 'student',
                title: '✅ تمت إضافتك إلى البث المباشر',
                message: `تمت إضافتك إلى البث المباشر للحصة "${offer.subject_name}".\n🔑 كلمة المرور: ${offer.room_password || ''}`,
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
        console.error('❌ خطأ في إضافة جميع الطلاب:', error.message);
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

        const totalMinutes = offer.duration || 0;
        const isPaused = offer.status === 'paused';

        // ✅ عرض صفحة البث (مبسطة)
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
                    .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 0.7rem; font-weight: 700; margin-bottom: 18px; }
                    .badge-live { background: #ef4444; color: white; animation: pulse 1.5s infinite; }
                    .badge-paused { background: #f59e0b; color: white; }
                    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
                    .info-box { background: #0f3460; border-radius: 12px; padding: 16px; margin: 16px 0; }
                    .info-box p { color: #94a3b8; font-size: 0.9rem; margin: 4px 0; }
                    .btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; border: none; padding: 14px 24px; border-radius: 12px; font-size: 1rem; font-weight: 700; cursor: pointer; margin-top: 12px; transition: all 0.3s; color: #fff; }
                    .btn-open { background: linear-gradient(135deg, #10b981, #059669); }
                    .btn-open:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(16,185,129,0.4); }
                    .btn-end { background: linear-gradient(135deg, #ef4444, #dc2626); }
                    .btn-end:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(239,68,68,0.4); }
                    .btn-group { display: flex; gap: 10px; flex-wrap: wrap; }
                    .btn-group .btn { flex: 1; min-width: 120px; }
                    .status { margin-top: 12px; padding: 12px; border-radius: 8px; font-size: 0.9rem; }
                    .status-success { background: rgba(16,185,129,0.2); color: #10b981; }
                    .status-error { background: rgba(239,68,68,0.2); color: #ef4444; }
                    @media(max-width:600px) { .container { padding: 24px; } }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="badge ${isPaused ? 'badge-paused' : 'badge-live'}">${isPaused ? '⏸ متوقف مؤقتاً' : '🔴 بث مباشر'}</div>
                    <h1>🎥 ${escapeHtml(offer.subject_name)}</h1>
                    
                    <div class="info-box">
                        <p>📚 مدة الحصة: ${totalMinutes} دقيقة</p>
                        <p>🔑 كلمة المرور: ${offer.room_password || 'غير متوفرة'}</p>
                    </div>

                    <button class="btn btn-open" onclick="window.open('${offer.stream_url}', '_blank')">🎥 فتح Jitsi Meet</button>
                    
                    <div class="btn-group">
                        <button class="btn btn-end" onclick="endStream()">⏹️ إنهاء البث</button>
                    </div>
                    
                    <div id="statusMessage"></div>
                    <p style="color: #94a3b8; font-size: 0.8rem; margin-top: 16px;">✅ Jitsi Meet يُفتح في نافذة جديدة (مجاني 100%)</p>
                </div>
                <script>
                    const API_BASE_URL = window.location.hostname === 'localhost' ? 'http://localhost:3000' : window.location.origin;
                    const authToken = '${token}';
                    const offerId = ${parseInt(offer_id)};
                    const isPaused = ${isPaused ? 'true' : 'false'};

                    function showStatus(message, isError) {
                        const el = document.getElementById('statusMessage');
                        el.className = 'status ' + (isError ? 'status-error' : 'status-success');
                        el.textContent = message;
                    }

                    async function endStream() {
                        if (!confirm('⏹️ هل تريد إنهاء البث؟ هذا الإجراء لا يمكن التراجع عنه.')) return;
                        try {
                            const res = await fetch(API_BASE_URL + '/api/stream/end/' + offerId, {
                                method: 'POST',
                                headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' }
                            });
                            const data = await res.json();
                            if (data.success) {
                                showStatus('✅ تم إنهاء البث بنجاح', false);
                                setTimeout(() => { window.location.href = '/teacher-dashboard.html'; }, 1500);
                            } else {
                                showStatus('❌ ' + (data.error || 'فشل في إنهاء البث'), true);
                            }
                        } catch (e) {
                            showStatus('❌ خطأ في الاتصال بالخادم', true);
                        }
                    }
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('خطأ في صفحة البث:', error);
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

        // ✅ التحقق من صلاحية الطالب
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

        const totalMinutes = offer.duration || 0;
        const isPaused = offer.status === 'paused';

        // ✅ عرض صفحة البث للطالب (مبسطة)
        res.send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>دخول البث المباشر</title>
                <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800;900&display=swap" rel="stylesheet">
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { font-family: 'Cairo', sans-serif; background: #0a0a1a; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
                    .container { max-width: 450px; width: 90%; background: #1a1a2e; border-radius: 24px; padding: 40px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
                    h1 { color: #0f5cbf; font-size: 1.5rem; margin-bottom: 6px; }
                    .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 0.7rem; font-weight: 700; margin-bottom: 12px; }
                    .badge-live { background: #ef4444; color: white; animation: pulse 1.5s infinite; }
                    .badge-paused { background: #f59e0b; color: white; }
                    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
                    .info-box { background: #0f3460; border-radius: 12px; padding: 12px; margin: 12px 0; }
                    .info-box p { color: #94a3b8; font-size: 0.9rem; margin: 4px 0; }
                    .password-box { background: rgba(96, 165, 250, 0.05); border: 1px solid rgba(96, 165, 250, 0.1); border-radius: 8px; padding: 12px; margin: 12px 0; }
                    .password-box span { font-family: 'Courier New', monospace; font-weight: 700; color: #60a5fa; letter-spacing: 2px; font-size: 1.2rem; }
                    .btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 14px 24px; border-radius: 12px; font-size: 1rem; font-weight: 700; cursor: pointer; width: 100%; transition: all 0.3s; margin-top: 12px; display: flex; align-items: center; justify-content: center; gap: 10px; }
                    .btn:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(16, 185, 129, 0.4); }
                    .info { color: #64748b; font-size: 0.8rem; margin-top: 16px; line-height: 1.6; }
                    .warning { color: #f59e0b; font-size: 0.75rem; margin-top: 10px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="badge ${isPaused ? 'badge-paused' : 'badge-live'}">${isPaused ? '⏸ متوقف مؤقتاً' : '🔴 بث مباشر'}</div>
                    <h1>🎥 ${escapeHtml(offer.subject_name)}</h1>
                    
                    <div class="info-box">
                        <p>📚 مدة الحصة: ${totalMinutes} دقيقة</p>
                    </div>
                    
                    <div class="password-box">
                        <p style="color: #94a3b8; font-size: 0.8rem;">🔑 كلمة المرور:</p>
                        <span>${offer.room_password || 'غير متوفرة'}</span>
                    </div>
                    
                    <button class="btn" onclick="window.open('${offer.stream_url}', '_blank')">
                        🎥 فتح Jitsi Meet
                    </button>
                    
                    <p class="info">
                        سيتم فتح Jitsi Meet في نافذة جديدة<br>
                        أدخل كلمة المرور أعلاه عند الطلب
                    </p>
                    <p class="warning">⚠️ لا تشارك كلمة المرور مع أي شخص خارج الحصة</p>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('خطأ في صفحة دخول البث:', error);
        res.status(500).send('حدث خطأ في تحميل صفحة البث');
    }
});

module.exports = router;
