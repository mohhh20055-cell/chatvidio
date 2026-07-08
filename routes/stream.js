// ============================================================
// مسارات البث المباشر - Stream Routes
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
        
        // ✅ حفظ بيانات البث في جدول العروض مباشرة
        await supabase
            .from('offers')
            .update({
                stream_url: roomUrl,
                stream_platform: 'jitsi',
                status: 'live',
                room_name: roomName,
                room_password: password,
                stream_started_at: new Date().toISOString()
            })
            .eq('id', offer_id);
        
        // ✅ جلب الطلاب المسجلين
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');
        
        // ✅ إنشاء كلمات مرور فريدة لكل طالب (أمان إضافي)
        if (sessions && sessions.length > 0) {
            // إرسال إشعارات للطلاب
            const notifications = sessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '🔴 البث المباشر بدأ',
                message: `الحصة "${offer.subject_name}" قد بدأت الآن. انضم عبر زر البث المباشر.`,
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
            students_count: sessions?.length || 0,
            message: 'تم بدء البث بنجاح (مجاني 100%)'
        });
    } catch (error) {
        console.error('❌ خطأ في بدء البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
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
            // ✅ تحديث التوكن كمستخدم
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
            console.log('❌ أخطاء في التحقق:', errors.array());
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, stream_url, platform } = req.body;

        console.log('📥 [save-link] محاولة حفظ رابط البث:');
        console.log('   - offer_id:', offer_id);
        console.log('   - stream_url:', stream_url);
        console.log('   - platform:', platform);

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }
        
        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ تحديث العرض مع رابط البث
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

        // ✅ إرسال إشعارات للطلاب المسجلين
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

            await supabase
                .from('notifications')
                .insert(notifications);
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

        // ✅ جلب جميع الطلاب المسجلين والمدفوعين في هذه الحصة
        const { data: paidSessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        if (!paidSessions || paidSessions.length === 0) {
            return res.json({ success: true, students_count: 0, message: 'لا يوجد طلاب مسجلين في هذه الحصة' });
        }

        // ✅ جلب من هم بالفعل في البث لتجنب التكرار
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

            // ✅ إزالة من قائمة الانتظار إذا وجدت
            try {
                await supabase
                    .from('waiting_room')
                    .delete()
                    .eq('offer_id', offer_id)
                    .eq('student_id', studentId);
            } catch (e) { /* ignore */ }

            // ✅ إشعار الطالب
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

        // ✅ عرض صفحة البث (Jitsi Meet يُفتح في نافذة جديدة - بدون iframe)
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
                    .container { max-width: 480px; width: 90%; background: #1a1a2e; border-radius: 24px; padding: 40px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
                    h1 { color: #0f5cbf; font-size: 1.5rem; margin-bottom: 6px; }
                    h1 span { color: #fff; }
                    .badge { display: inline-block; background: #10b981; padding: 4px 14px; border-radius: 20px; font-size: 0.7rem; font-weight: 700; margin-bottom: 18px; }
                    .btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; border: none; padding: 16px 30px; border-radius: 12px; font-size: 1.05rem; font-weight: 700; cursor: pointer; margin-top: 14px; transition: all 0.3s; color: #fff; }
                    .btn-open { background: linear-gradient(135deg, #10b981, #059669); }
                    .btn-open:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(16,185,129,0.4); }
                    .btn-end { background: linear-gradient(135deg, #ef4444, #dc2626); }
                    .btn-end:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(239,68,68,0.4); }
                    .info { color: #94a3b8; font-size: 0.85rem; margin-top: 16px; line-height: 1.7; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="badge">🔴 بث مباشر</div>
                    <h1>🎥 <span>${escapeHtml(offer.subject_name)}</span></h1>
                    <button class="btn btn-open" onclick="openStream()">🎥 فتح البث المباشر (Jitsi Meet)</button>
                    <button class="btn btn-end" onclick="endStream()">⏹️ إنهاء البث</button>
                    <p class="info">✅ سيُفتح Jitsi Meet في نافذة جديدة (مجاني 100%)<br>تأكد من السماح بالنوافذ المنبثقة</p>
                </div>
                <script>
                    const API_BASE_URL = window.location.hostname === 'localhost' ? 'http://localhost:3000' : window.location.origin;
                    const authToken = '${token}';
                    const offerId = ${parseInt(offer_id)};
                    const teacherId = ${parseInt(teacher_id)};
                    const roomUrl = '${offer.stream_url}';

                    function openStream() {
                        const w = window.open(roomUrl, '_blank');
                        if (!w) alert('⚠️ يرجى السماح بفتح النوافذ المنبثقة');
                    }

                    // فتح البث تلقائياً عند تحميل الصفحة
                    openStream();

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

        // ✅ جلب كلمة المرور الفريدة للطالب
        const { data: studentPassword } = await supabase
            .from('student_room_passwords')
            .select('password')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .eq('used', false)
            .single();

        // ✅ إذا لم توجد كلمة مرور، استخدم كلمة مرور الغرفة العامة
        const password = studentPassword?.password || offer.room_password || '';

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

        // ✅ عرض صفحة دخول Jitsi (بدون iframe)
        res.send(generateJitsiJoinPage(offer, password));
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
// ✅ دالة توليد صفحة دخول Jitsi
// ============================================================

function generateJitsiJoinPage(offer, password) {
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
        h1 { color: #0f5cbf; font-size: 1.5rem; margin-bottom: 10px; }
        .subtitle { color: #94a3b8; font-size: 0.9rem; margin-bottom: 20px; }
        .password-box { background: #0f3460; padding: 20px; border-radius: 12px; margin: 20px 0; border: 2px dashed rgba(96, 165, 250, 0.3); }
        .password-box span { color: #60a5fa; font-size: 1.8rem; font-weight: 900; letter-spacing: 4px; font-family: 'Courier New', monospace; }
        .password-label { color: #94a3b8; font-size: 0.8rem; margin-bottom: 8px; }
        .btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 16px 30px; border-radius: 12px; font-size: 1.1rem; font-weight: 700; cursor: pointer; width: 100%; transition: all 0.3s; margin-top: 20px; display: flex; align-items: center; justify-content: center; gap: 10px; }
        .btn:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(16, 185, 129, 0.4); }
        .info { color: #64748b; font-size: 0.8rem; margin-top: 16px; line-height: 1.6; }
        .info i { color: #f59e0b; }
        .copy-btn { background: transparent; border: 1px solid #333; color: #94a3b8; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 0.8rem; transition: all 0.3s; margin-top: 8px; }
        .copy-btn:hover { background: #1a1a2e; border-color: #0f5cbf; color: white; }
        .warning { color: #f59e0b; font-size: 0.75rem; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎥 ${escapeHtml(subjectName)}</h1>
        <p class="subtitle">🔐 أدخل كلمة المرور للدخول إلى البث المباشر</p>
        
        <div class="password-box">
            <div class="password-label">🔑 كلمة مرور البث</div>
            <span id="roomPassword">${password}</span>
            <br>
            <button class="copy-btn" onclick="copyPassword()">
                <i class="fas fa-copy"></i> نسخ كلمة المرور
            </button>
        </div>
        
        <button class="btn" onclick="joinJitsi()">
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
            // ✅ فتح Jitsi في نافذة جديدة (بدون iframe)
            const newWindow = window.open(roomUrl, '_blank');
            
            if (newWindow) {
                setTimeout(() => {
                    alert('🔑 كلمة المرور: ' + password + '\\n\\nأدخلها عند الطلب في صفحة Jitsi');
                }, 2000);
            } else {
                alert('⚠️ يرجى السماح بفتح النوافذ المنبثقة');
            }
        }
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
