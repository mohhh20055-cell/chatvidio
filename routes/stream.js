// ============================================================
// مسارات البث المباشر - Stream Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');

const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');

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
// حفظ رابط البث
// ============================================================
router.post('/save-link', authenticate, authorize(['teacher']), [
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('stream_url').notEmpty().withMessage('رابط البث مطلوب'),
    body('platform').isIn(['google-meet', 'microsoft-teams', 'other']).withMessage('منصة غير صالحة')
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

        await supabase
            .from('offers')
            .update({
                stream_url: stream_url,
                stream_platform: platform,
                status: 'live',
                stream_started_at: new Date().toISOString()
            })
            .eq('id', offer_id);

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
                message: `الحصة "${offer.subject_name}" قد بدأت الآن. انضم عبر الرابط: ${stream_url}`,
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
            platform: platform
        });
    } catch (error) {
        console.error('❌ خطأ في حفظ رابط البث:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
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
            message: `تمت إضافتك إلى البث المباشر للحصة "${offer.subject_name}". انضم الآن عبر زر البث المباشر.`,
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
                    message: `تمت إضافتك إلى البث المباشر للحصة "${offer.subject_name}". انضم الآن عبر زر البث المباشر.`,
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
            message: `تم إضافة ${addedCount} طالب إلى البث`
        });
    } catch (error) {
        console.error('❌ خطأ في إضافة جميع الطلاب:', error.message);
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
// حالة البث
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

module.exports = router;
