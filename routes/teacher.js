// ============================================================
// مسارات الأستاذ - Teacher Routes (معدل بالكامل)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');

const { supabase } = require('../config/database');
// ✅ استيراد authorize من middleware مباشرة (بدون تعريف محلي)
const { authenticate, authorize, checkBanned } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');
const { uploadToSupabase, validateUploadedFiles } = require('../utils/upload');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE, files: 5 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            return cb(new Error('نوع الملف غير مدعوم'), false);
        }
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
            return cb(new Error('امتداد الملف غير مدعوم'), false);
        }
        cb(null, true);
    }
});

// ============================================================
// جلب بيانات الأستاذ
// ============================================================
router.get('/:teacher_id', authenticate, [
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = parseInt(req.params.teacher_id);

        if (req.user.userId !== teacher_id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المعلومات' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        }
        
        // ✅ إزالة كلمة المرور من البيانات المرسلة
        delete teacher.password;
        
        res.json(teacher);
    } catch (error) {
        console.error('خطأ في جلب بيانات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث صورة الأستاذ
// ============================================================
router.post('/update-profile', authenticate, authorize(['teacher']), upload.single('profile_image'), validateUploadedFiles, [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id } = req.body;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'الرجاء اختيار صورة' });
        }

        const oldTeacher = await getOne('teachers', 'id', teacher_id);
        if (!oldTeacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        const uploaded = await uploadToSupabase(req.file, 'teachers', oldTeacher?.profile_image);
        if (!uploaded) {
            return res.status(500).json({ success: false, error: 'فشل رفع الصورة' });
        }

        const updateData = {
            profile_image: uploaded.filename,
            profile_url: uploaded.url,
            updated_at: new Date().toISOString()
        };

        const { data, error } = await supabase
            .from('teachers')
            .update(updateData)
            .eq('id', teacher_id)
            .select();

        if (error) throw error;

        res.json({ 
            success: true, 
            message: 'تم تحديث الصورة الشخصية بنجاح', 
            user: data ? data[0] : null 
        });
    } catch (error) {
        console.error('خطأ في تحديث الصورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث الملف الشخصي مع الروابط الاجتماعية
// ============================================================
router.post('/update-profile-with-social', authenticate, authorize(['teacher']), upload.fields([
    { name: 'profile_image', maxCount: 1 }
]), validateUploadedFiles, [
    body('teacher_id').isInt().withMessage('معرف الأستاذ مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, facebook_url, instagram_url, linkedin_url, youtube_url, twitter_url, website_url, whatsapp_url } = req.body;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        let profile_image = null;
        let profile_url = null;

        const oldTeacher = await getOne('teachers', 'id', teacher_id);
        if (!oldTeacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        // ✅ التحقق من وجود ملف الصورة
        if (req.files && req.files['profile_image'] && req.files['profile_image'][0]) {
            const file = req.files['profile_image'][0];
            const uploaded = await uploadToSupabase(file, 'teachers', oldTeacher?.profile_image);
            if (uploaded) {
                profile_image = uploaded.filename;
                profile_url = uploaded.url;
            }
        }

        const updateData = {
            updated_at: new Date().toISOString()
        };

        if (profile_image) { updateData.profile_image = profile_image; }
        if (profile_url) { updateData.profile_url = profile_url; }

        // ✅ معالجة الروابط الاجتماعية
        const socialFields = {
            facebook_url,
            instagram_url,
            linkedin_url,
            youtube_url,
            twitter_url,
            website_url,
            whatsapp_url
        };

        for (const [key, value] of Object.entries(socialFields)) {
            if (value !== undefined && value !== null) {
                const cleaned = value.trim();
                if (cleaned && !cleaned.match(/^https?:\/\/.+/)) {
                    return res.status(400).json({ 
                        success: false, 
                        error: `الرابط ${key} غير صالح. يجب أن يبدأ بـ http:// أو https://` 
                    });
                }
                updateData[key] = cleaned === '' ? null : cleaned;
            }
        }

        const { data, error } = await supabase
            .from('teachers')
            .update(updateData)
            .eq('id', teacher_id)
            .select();

        if (error) throw error;

        res.json({
            success: true,
            message: 'تم تحديث الملف الشخصي وروابط التواصل الاجتماعي بنجاح',
            user: data ? data[0] : null
        });
    } catch (error) {
        console.error('خطأ في تحديث الملف الشخصي:', error.message);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ أثناء تحديث الملف الشخصي' });
    }
});

// ============================================================
// جلب الرصيد والأرباح (معدل - تم إصلاح خطأ الاستعلام)
// ============================================================
router.get('/balance/:teacher_id', authenticate, authorize(['teacher']), [
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = parseInt(req.params.teacher_id);

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المعلومات' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        }

        // ✅ إصلاح: جلب الجلسات المدفوعة المرتبطة بعروض الأستاذ
        const { data: paidSessions, error: sessionsError } = await supabase
            .from('sessions')
            .select(`
                *,
                offers:offer_id (
                    subject_name,
                    teacher_id
                )
            `)
            .eq('payment_status', 'paid')
            .eq('offers.teacher_id', teacher_id)
            .order('created_at', { ascending: false });

        if (sessionsError) {
            console.error('خطأ في جلب الجلسات:', sessionsError.message);
        }

        res.json({
            balance: teacher.balance || 0,
            total_earned: teacher.total_earned || 0,
            pending_withdraw: teacher.pending_withdraw || 0,
            total_withdrawn: teacher.total_withdrawn || 0,
            sessions: paidSessions || []
        });
    } catch (error) {
        console.error('خطأ في جلب الرصيد:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// طلب سحب
// ============================================================
router.post('/withdraw-request', authenticate, authorize(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('amount').isFloat({ min: 100, max: 1000000 }).withMessage('المبلغ غير صالح (الحد الأدنى 100 دج)'),
    body('ccp_account').isLength({ min: 10, max: 20 }).withMessage('رقم حساب CCP غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, amount, ccp_account } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بطلب السحب' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        }

        if ((teacher.balance || 0) < amount) {
            return res.status(400).json({ 
                success: false, 
                error: `الرصيد غير كافٍ. رصيدك الحالي: ${teacher.balance} دج` 
            });
        }

        // ✅ التحقق من وجود طلب سحب معلق
        const { data: pendingRequest } = await supabase
            .from('withdraw_requests')
            .select('id')
            .eq('teacher_id', teacher_id)
            .eq('status', 'pending')
            .single();

        if (pendingRequest) {
            return res.status(400).json({ 
                success: false, 
                error: 'لديك طلب سحب معلق بالفعل، يرجى الانتظار حتى يتم معالجته' 
            });
        }

        const withdrawRequest = await insert('withdraw_requests', {
            teacher_id: parseInt(teacher_id),
            amount: parseFloat(amount),
            ccp_account: ccp_account.trim(),
            status: 'pending',
            created_at: new Date().toISOString()
        });

        await update('teachers', teacher_id, {
            balance: (teacher.balance || 0) - amount,
            pending_withdraw: (teacher.pending_withdraw || 0) + amount,
            updated_at: new Date().toISOString()
        });

        // ✅ إرسال إشعار للمدرس
        await insert('notifications', {
            user_id: teacher_id,
            user_type: 'teacher',
            title: '💰 طلب سحب جديد',
            message: `تم تقديم طلب سحب بمبلغ ${amount} دج إلى حساب CCP: ${ccp_account}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ 
            success: true, 
            message: 'تم تقديم طلب السحب بنجاح، سيتم معالجته في أقرب وقت',
            request: withdrawRequest 
        });
    } catch (error) {
        console.error('خطأ في طلب السحب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب طلبات السحب
// ============================================================
router.get('/withdraw-requests/:teacher_id', authenticate, authorize(['teacher']), [
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = parseInt(req.params.teacher_id);

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه الطلبات' });
        }

        const { data, error } = await supabase
            .from('withdraw_requests')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب طلبات السحب:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب عروض الأستاذ (معدل - مع كلمات المرور)
// ============================================================
router.get('/offers/:teacher_id', authenticate, authorize(['teacher']), [
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = parseInt(req.params.teacher_id);

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه العروض' });
        }

        // ✅ جلب العروض مع كلمات المرور من جدول jitsi_rooms
        const { data, error } = await supabase
            .from('offers')
            .select('*, jitsi_rooms!left(offer_id) (password, room_name, room_url)')
            .eq('teacher_id', teacher_id)
            .order('offer_date', { ascending: false });

        if (error) throw error;

        // ✅ تنسيق البيانات مع كلمات المرور
        const formatted = (data || []).map(offer => {
            const jitsiData = offer.jitsi_rooms || {};
            
            return {
                id: offer.id,
                teacher_id: offer.teacher_id,
                subject_name: offer.subject_name,
                duration: offer.duration,
                offer_date: offer.offer_date,
                price: offer.price,
                is_free: offer.is_free,
                status: offer.status,
                education_level: offer.education_level,
                room_name: offer.room_name || jitsiData.room_name || null,
                room_password: jitsiData.password || offer.room_password || null,
                stream_url: offer.stream_url || jitsiData.room_url || null,
                stream_platform: offer.stream_platform || 'jitsi',
                created_at: offer.created_at,
                updated_at: offer.updated_at
            };
        });

        res.json(formatted || []);
    } catch (error) {
        console.error('خطأ في جلب عروض الأستاذ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب عرض محدد للأستاذ (معدل - مع كلمة المرور)
// ============================================================
router.get('/offer/:offer_id', authenticate, authorize(['teacher']), [
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
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذا العرض' });
        }

        // ✅ جلب كلمة المرور من جدول jitsi_rooms
        const { data: jitsiRoom } = await supabase
            .from('jitsi_rooms')
            .select('password, room_name, room_url')
            .eq('offer_id', offer_id)
            .single();

        // ✅ جلب عدد الطلاب المسجلين
        const { count: studentsCount } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        res.json({
            ...offer,
            room_password: jitsiRoom?.password || offer.room_password || null,
            jitsi_room_name: jitsiRoom?.room_name || null,
            jitsi_room_url: jitsiRoom?.room_url || null,
            students_count: studentsCount || 0
        });
    } catch (error) {
        console.error('خطأ في جلب العرض:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ تحديث كلمة مرور العرض (ميزة جديدة للأستاذ)
// ============================================================
router.put('/offer/update-password/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('password').isLength({ min: 4, max: 10 }).withMessage('كلمة المرور يجب أن تكون بين 4 و 10 أحرف')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const { password } = req.body;

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ تحديث كلمة المرور في جدول offers
        await update('offers', offer_id, { 
            room_password: password,
            updated_at: new Date().toISOString()
        });

        // ✅ تحديث كلمة المرور في جدول jitsi_rooms إذا كانت موجودة
        const { data: jitsiRoom } = await supabase
            .from('jitsi_rooms')
            .select('id')
            .eq('offer_id', offer_id)
            .single();

        if (jitsiRoom) {
            await supabase
                .from('jitsi_rooms')
                .update({ 
                    password: password,
                    updated_at: new Date().toISOString()
                })
                .eq('id', jitsiRoom.id);
        }

        res.json({
            success: true,
            message: 'تم تحديث كلمة المرور بنجاح',
            new_password: password
        });
    } catch (error) {
        console.error('خطأ في تحديث كلمة المرور:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب إحصائيات الأستاذ
// ============================================================
router.get('/stats/:teacher_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);
        
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ عدد العروض
        const { count: totalOffers } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('teacher_id', teacher_id);

        // ✅ عدد العروض النشطة
        const { count: activeOffers } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('teacher_id', teacher_id)
            .eq('status', 'live');

        // ✅ عدد الطلاب المسجلين
        const { count: totalStudents } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('teacher_id', teacher_id)
            .eq('payment_status', 'paid');

        // ✅ عدد الحصص المكتملة
        const { count: completedSessions } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('teacher_id', teacher_id)
            .eq('payment_status', 'paid')
            .eq('completed', true);

        res.json({
            total_offers: totalOffers || 0,
            active_offers: activeOffers || 0,
            total_students: totalStudents || 0,
            completed_sessions: completedSessions || 0
        });
    } catch (error) {
        console.error('خطأ في جلب إحصائيات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
