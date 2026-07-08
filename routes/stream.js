// ============================================================
// مسارات البث المباشر - Stream Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const path = require('path');

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
// حفظ رابط البث - ✅ نسخة معدلة مع تحقق إضافي
// ============================================================
router.post('/save-link', authenticate, authorize(['teacher']), [
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('stream_url').notEmpty().withMessage('رابط البث مطلوب'),
    body('platform').isIn(['google-meet', 'microsoft-teams', 'other']).withMessage('منصة غير صالحة')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.log('❌ أخطاء في التحقق:', errors.array());
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, stream_url, platform } = req.body;

        console.log('📥 [save-link] محاولة حفظ رابط البث:');
        console.log('   - offer_id:', offer_id);
        console.log('   - stream_url:', stream_url);
        console.log('   - platform:', platform);
        console.log('   - teacher_id:', req.user.userId);

        // ✅ التحقق من وجود العرض
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            console.log('❌ العرض غير موجود:', offer_id);
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }
        
        console.log('✅ العرض موجود:', {
            id: offer.id,
            subject: offer.subject_name,
            teacher_id: offer.teacher_id,
            current_status: offer.status
        });

        // ✅ التحقق من أن المستخدم هو صاحب العرض
        if (offer.teacher_id !== req.user.userId) {
            console.log('❌ غير مصرح: المستخدم', req.user.userId, 'ليس مالك العرض');
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ تحديث العرض مع رابط البث
        console.log('🔄 جاري تحديث العرض...');
        const { data, error } = await supabase
            .from('offers')
            .update({
                stream_url: stream_url,
                stream_platform: platform,
                status: 'live',
                stream_started_at: new Date().toISOString()
            })
            .eq('id', offer_id)
            .select();

        if (error) {
            console.error('❌ خطأ في تحديث العرض:', error);
            return res.status(500).json({ success: false, error: 'فشل تحديث العرض: ' + error.message });
        }

        console.log('✅ تم تحديث العرض بنجاح:', data);

        // ✅ التحقق من التحديث
        const { data: updatedOffer, error: checkError } = await supabase
            .from('offers')
            .select('id, stream_url, stream_platform, status')
            .eq('id', offer_id)
            .single();

        if (checkError) {
            console.error('❌ خطأ في التحقق من التحديث:', checkError);
        } else {
            console.log('✅ التحقق من التحديث:', updatedOffer);
        }

        // ✅ إرسال إشعارات للطلاب المسجلين
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        console.log('📢 عدد الطلاب المسجلين:', sessions?.length || 0);

        if (sessions && sessions.length > 0) {
            const notifications = sessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '🔴 البث المباشر بدأ',
                message: 'الحصة "' + offer.subject_name + '" قد بدأت الآن. انضم عبر الرابط: ' + stream_url,
                offer_id: offer_id,
                stream_url: stream_url,
                is_read: false,
                created_at: new Date().toISOString()
            }));

            const { error: notifError } = await supabase
                .from('notifications')
                .insert(notifications);

            if (notifError) {
                console.error('❌ خطأ في إرسال الإشعارات:', notifError);
            } else {
                console.log('✅ تم إرسال', notifications.length, 'إشعار');
            }
        }

        res.json({
            success: true,
            message: 'تم بدء البث المباشر بنجاح',
            stream_url: stream_url,
            platform: platform,
            offer_id: offer_id,
            updated_offer: updatedOffer
        });
    } catch (error) {
        console.error('❌ خطأ في حفظ رابط البث:', error.message);
        console.error('📚 Stack:', error.stack);
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
// إضافة جميع الطلاب إلى البث
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

        const { data: waitingStudents } = await supabase
            .from('waiting_room')
            .select('student_id')
            .eq('offer_id', offer_id);

        if (!waitingStudents || waitingStudents.length === 0) {
            return res.json({ success: true, students_count: 0, message: 'لا يوجد طلاب في قائمة الانتظار' });
        }

        let addedCount = 0;
        const addedStudents = [];

        for (const student of waitingStudents) {
            const session = await getOne('sessions', 'offer_id', offer_id);
            if (session && session.student_id === student.student_id && session.payment_status === 'paid') {
                await insert('active_stream', {
                    offer_id: parseInt(offer_id),
                    student_id: student.student_id,
                    added_at: new Date().toISOString(),
                    added_by_teacher: true
                });

                await supabase
                    .from('waiting_room')
                    .delete()
                    .eq('offer_id', offer_id)
                    .eq('student_id', student.student_id);

                await insert('notifications', {
                    user_id: student.student_id,
                    user_type: 'student',
                    title: '✅ تمت إضافتك إلى البث المباشر',
                    message: 'تمت إضافتك إلى البث المباشر للحصة "' + offer.subject_name + '". انضم الآن عبر زر البث المباشر.',
                    offer_id: offer_id,
                    is_read: false,
                    created_at: new Date().toISOString()
                });

                addedCount++;
                addedStudents.push(student.student_id);
            } else {
                await supabase
                    .from('waiting_room')
                    .delete()
                    .eq('offer_id', offer_id)
                    .eq('student_id', student.student_id);
            }
        }

        res.json({ 
            success: true, 
            students_count: addedCount,
            students: addedStudents,
            message: 'تم إضافة ' + addedCount + ' طالب إلى البث'
        });
    } catch (error) {
        console.error('❌ خطأ في إضافة جميع الطلاب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إضافة الطلاب (API قديم)
// ============================================================
router.post('/add-students/:offer_id', authenticate, authorize(['teacher']), [
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

        if (!offer || offer.teacher_id != teacher_id) {
            return res.status(403).json({ success: false });
        }

        await update('offers', offer_id, { status: 'live' });

        const { data: waitingStudents } = await supabase
            .from('waiting_room')
            .select('student_id')
            .eq('offer_id', offer_id);

        const addedStudents = [];

        for (const student of waitingStudents || []) {
            const session = await getOne('sessions', 'offer_id', offer_id);
            if (session && session.student_id === student.student_id && session.payment_status === 'paid') {
                await insert('active_stream', { 
                    offer_id: parseInt(offer_id), 
                    student_id: student.student_id,
                    added_at: new Date().toISOString()
                });

                await insert('notifications', {
                    user_id: student.student_id,
                    user_type: 'student',
                    title: '🔴 البث المباشر بدأ',
                    message: 'الحصة "' + offer.subject_name + '" قد بدأت الآن. انضم إلى البث المباشر.',
                    offer_id: offer_id,
                    stream_url: offer.stream_url,
                    is_read: false,
                    created_at: new Date().toISOString()
                });

                addedStudents.push(student.student_id);

                await supabase
                    .from('waiting_room')
                    .delete()
                    .eq('offer_id', offer_id)
                    .eq('student_id', student.student_id);
            } else {
                await supabase
                    .from('waiting_room')
                    .delete()
                    .eq('offer_id', offer_id)
                    .eq('student_id', student.student_id);
            }
        }

        res.json({ success: true, students_count: addedStudents.length, students: addedStudents });
    } catch (error) {
        console.error('❌ خطأ في إضافة الطلاب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إنهاء البث
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

        await update('offers', offer_id, { status: 'completed' });
        await supabase.from('active_stream').delete().eq('offer_id', offer_id);
        await supabase.from('waiting_room').delete().eq('offer_id', offer_id);
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في إنهاء البث:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// حالة البث (عام)
// ============================================================
router.get('/status/:offer_id', async (req, res) => {
    try {
        const offer = await getOne('offers', 'id', req.params.offer_id);
        res.json({ 
            status: offer?.status || 'not_found', 
            stream_url: offer?.stream_url || null,
            platform: offer?.stream_platform || null
        });
    } catch (error) {
        console.error('خطأ في جلب حالة البث:', error.message);
        res.status(500).json({ status: 'not_found' });
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

        // التحقق من أن البث مباشر
        if (offer.status !== 'live' || !offer.stream_url) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#f59e0b;">⏳ البث لم يبدأ بعد</h1>
                    <p style="color:#64748b;">يرجى بدء البث أولاً من صفحة العروض</p>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        // عرض صفحة البث مع iframe
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
                    body { font-family: 'Cairo', Arial, sans-serif; background: #0a0a1a; color: white; overflow: hidden; height: 100vh; }
                    .header { background: linear-gradient(135deg, #0f3460, #1a1a2e); padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1a1a2e; }
                    .header .title { font-size: 1.1rem; font-weight: 800; color: #0f5cbf; }
                    .header .title span { color: white; }
                    .header .badge { background: #10b981; padding: 4px 14px; border-radius: 20px; font-size: 0.7rem; font-weight: 700; }
                    .header .btn-end { background: #ef4444; color: white; border: none; padding: 6px 18px; border-radius: 20px; cursor: pointer; font-weight: 700; font-size: 0.8rem; transition: all 0.3s; }
                    .header .btn-end:hover { background: #dc2626; transform: scale(1.05); }
                    .video-container { height: calc(100vh - 70px); width: 100%; background: #0a0a1a; display: flex; align-items: center; justify-content: center; }
                    .video-container iframe { width: 100%; height: 100%; border: none; }
                    .waiting-message { text-align: center; color: #94a3b8; padding: 40px; }
                    .waiting-message .spinner { display: inline-block; width: 40px; height: 40px; border: 4px solid #0f3460; border-top: 4px solid #0f5cbf; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 20px; }
                    @keyframes spin { to { transform: rotate(360deg); } }
                    @media(max-width:768px) {
                        .header { padding: 8px 14px; flex-wrap: wrap; gap: 6px; }
                        .header .title { font-size: 0.9rem; }
                        .video-container { height: calc(100vh - 60px); }
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="title">🎥 <span>${escapeHtml(offer.subject_name)}</span></div>
                    <div>
                        <span class="badge">🔴 بث مباشر</span>
                        <button class="btn-end" onclick="endStream()"><i class="fas fa-stop"></i> إنهاء البث</button>
                    </div>
                </div>
                <div class="video-container">
                    <iframe 
                        src="${offer.stream_url}"
                        allow="camera; microphone; autoplay; display-capture; fullscreen"
                        allowfullscreen>
                    </iframe>
                </div>
                <script>
                    const API_BASE_URL = window.location.hostname === 'localhost' ? 'http://localhost:3000' : window.location.origin;
                    const authToken = '${token}';
                    const offerId = ${parseInt(offer_id)};
                    const teacherId = ${parseInt(teacher_id)};

                    async function endStream() {
                        if (!confirm('⚠️ هل أنت متأكد من إنهاء البث المباشر؟')) return;
                        try {
                            const response = await fetch(API_BASE_URL + '/api/stream/end/' + offerId, {
                                method: 'POST',
                                headers: {
                                    'Authorization': 'Bearer ' + authToken,
                                    'Content-Type': 'application/json'
                                }
                            });
                            const data = await response.json();
                            if (data.success) {
                                alert('✅ تم إنهاء البث المباشر بنجاح');
                                window.location.href = '/teacher-dashboard.html';
                            } else {
                                alert('❌ ' + (data.error || 'حدث خطأ'));
                            }
                        } catch (error) {
                            console.error('خطأ:', error);
                            alert('❌ حدث خطأ في إنهاء البث');
                        }
                    }

                    // تحديث حالة البث كل 30 ثانية
                    setInterval(async () => {
                        try {
                            const response = await fetch(API_BASE_URL + '/api/stream/status/' + offerId);
                            const data = await response.json();
                            if (data.status !== 'live') {
                                alert('⏹️ انتهى البث المباشر');
                                window.location.href = '/teacher-dashboard.html';
                            }
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
// ✅ صفحة البث للطالب (لدخول البث)
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
        if (!session || session.student_id !== parseInt(student_id) || session.payment_status !== 'paid') {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ يجب حجز الحصة أولاً</h1>
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

        // ✅ التحقق من أن البث مباشر
        if (offer.status !== 'live' || !offer.stream_url) {
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

        // ✅ إضافة الطالب إلى active_stream إذا لم يكن موجوداً
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
            console.log('✅ تم إضافة الطالب', student_id, 'إلى active_stream تلقائياً');
        }

        // ✅ تحديث الإشعار كمقروء
        await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('offer_id', offer_id)
            .eq('user_id', student_id);

        // ✅ عرض صفحة البث مع iframe
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
                    body { font-family: 'Cairo', Arial, sans-serif; background: #0a0a1a; color: white; overflow: hidden; height: 100vh; }
                    .header { background: linear-gradient(135deg, #0f3460, #1a1a2e); padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1a1a2e; }
                    .header .title { font-size: 1.1rem; font-weight: 800; color: #0f5cbf; }
                    .header .title span { color: white; }
                    .header .badge { background: #10b981; padding: 4px 14px; border-radius: 20px; font-size: 0.7rem; font-weight: 700; }
                    .header .btn-leave { background: #ef4444; color: white; border: none; padding: 6px 18px; border-radius: 20px; cursor: pointer; font-weight: 700; font-size: 0.8rem; transition: all 0.3s; }
                    .header .btn-leave:hover { background: #dc2626; transform: scale(1.05); }
                    .video-container { height: calc(100vh - 70px); width: 100%; background: #0a0a1a; display: flex; align-items: center; justify-content: center; }
                    .video-container iframe { width: 100%; height: 100%; border: none; }
                    .waiting-message { text-align: center; color: #94a3b8; padding: 40px; }
                    .waiting-message .spinner { display: inline-block; width: 40px; height: 40px; border: 4px solid #0f3460; border-top: 4px solid #0f5cbf; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 20px; }
                    @keyframes spin { to { transform: rotate(360deg); } }
                    @media(max-width:768px) {
                        .header { padding: 8px 14px; flex-wrap: wrap; gap: 6px; }
                        .header .title { font-size: 0.9rem; }
                        .video-container { height: calc(100vh - 60px); }
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="title">🎥 <span>${escapeHtml(offer.subject_name)}</span></div>
                    <div>
                        <span class="badge">🔴 بث مباشر</span>
                        <button class="btn-leave" onclick="leaveStream()"><i class="fas fa-sign-out-alt"></i> مغادرة</button>
                    </div>
                </div>
                <div class="video-container">
                    <iframe 
                        src="${offer.stream_url}"
                        allow="camera; microphone; autoplay; display-capture; fullscreen"
                        allowfullscreen>
                    </iframe>
                </div>
                <script>
                    const API_BASE_URL = window.location.hostname === 'localhost' ? 'http://localhost:3000' : window.location.origin;
                    const authToken = '${token}';
                    const offerId = ${parseInt(offer_id)};
                    const studentId = ${parseInt(student_id)};

                    function leaveStream() {
                        if (confirm('⚠️ هل تريد مغادرة البث المباشر؟')) {
                            window.location.href = '/student-dashboard.html';
                        }
                    }

                    // تحديث حالة البث كل 30 ثانية
                    setInterval(async () => {
                        try {
                            const response = await fetch(API_BASE_URL + '/api/stream/status/' + offerId);
                            const data = await response.json();
                            if (data.status !== 'live') {
                                alert('⏹️ انتهى البث المباشر');
                                window.location.href = '/student-dashboard.html';
                            }
                        } catch(e) { console.error(e); }
                    }, 30000);

                    console.log('✅ تم تهيئة صفحة البث للطالب');
                </script>
            </body>
            </html>
        `);
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

// دالة مساعدة
function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
