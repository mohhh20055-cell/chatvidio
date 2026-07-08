// ============================================================
// مسارات الأستاذ - Teacher Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');

// استيراد الدوال المساعدة
const { supabase } = require('../config/database');
const { authenticate, authorize, checkBanned } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');
const { uploadToSupabase, validateUploadedFiles, ALLOWED_MIME_TYPES, ALLOWED_EXTENSIONS, MAX_FILE_SIZE } = require('../utils/upload');

// ============================================================
// إعداد Multer
// ============================================================
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 5
    },
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
        if (!teacher) return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        
        delete teacher.password;
        
        res.json(teacher);
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث صورة الأستاذ الشخصية
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

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'الرجاء اختيار صورة' });
        }

        const oldTeacher = await getOne('teachers', 'id', teacher_id);
        const uploaded = await uploadToSupabase(req.file, 'teachers', oldTeacher?.profile_image);
        if (!uploaded) return res.status(500).json({ success: false, error: 'فشل رفع الصورة' });

        const updateData = {
            profile_image: uploaded.filename,
            profile_url: uploaded.url
        };

        const { data, error } = await supabase
            .from('teachers')
            .update(updateData)
            .eq('id', teacher_id)
            .select();

        if (error) throw error;

        res.json({ success: true, message: 'تم تحديث الصورة الشخصية', user: data[0] });
    } catch (error) {
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

        if (req.files?.['profile_image']?.[0]) {
            const file = req.files['profile_image'][0];
            const uploaded = await uploadToSupabase(file, 'teachers', oldTeacher?.profile_image);
            if (uploaded) {
                profile_image = uploaded.filename;
                profile_url = uploaded.url;
            }
        }

        const updateData = {};

        if (profile_image) { updateData.profile_image = profile_image; }
        if (profile_url) { updateData.profile_url = profile_url; }

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
                    return res.status(400).json({ success: false, error: `الرابط ${key} غير صالح` });
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
// جلب الرصيد والأرباح
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
        if (!teacher) return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });

        const { data: paidSessions } = await supabase
            .from('sessions')
            .select('*, offers:offer_id (subject_name)')
            .eq('payment_status', 'paid')
            .eq('offer_id', teacher_id)
            .order('created_at', { ascending: false });

        res.json({
            balance: teacher.balance || 0,
            total_earned: teacher.total_earned || 0,
            sessions: paidSessions || []
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// طلب سحب
// ============================================================
router.post('/withdraw-request', authenticate, authorize(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('amount').isFloat({ min: 1, max: 1000000 }).withMessage('المبلغ غير صالح'),
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
        if (!teacher) return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });

        if ((teacher.balance || 0) < amount) {
            return res.status(400).json({ success: false, error: 'الرصيد غير كافٍ' });
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
            pending_withdraw: (teacher.pending_withdraw || 0) + amount
        });

        res.json({ success: true, request: withdrawRequest });
    } catch (error) {
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

        const { data } = await supabase
            .from('withdraw_requests')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

// ============================================================
// جلب عروض الأستاذ
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

        const { data } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('offer_date', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

module.exports = router;
