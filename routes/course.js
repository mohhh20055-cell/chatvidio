// ============================================================
// مسارات الدورات - Course Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { supabase } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');

const ALLOWED_TERABOX_DOMAINS = [
    '1024terabox.com',
    'terabox.com',
    '4funbox.com',
    'mirrobox.com',
    'teraboxlink.com',
    'teraboxlinks.com',
    'nephobox.com',
    'terabox.club',
    '1024tera.com'
];

function isTeraboxUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        const normalized = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
        return ALLOWED_TERABOX_DOMAINS.some(domain => normalized === domain || normalized.endsWith('.' + domain));
    } catch {
        return false;
    }
}

// ============================================================
// ✅ إنشاء دورة جديدة (للأستاذ فقط)
// ============================================================
router.post('/create', authenticate, authorize(['teacher']), [
    body('title').notEmpty().withMessage('اسم الدورة مطلوب').isLength({ max: 200 }),
    body('price').isFloat({ min: 0 }).withMessage('السعر غير صالح'),
    body('education_level').notEmpty().withMessage('المستوى التعليمي مطلوب'),
    body('course_url').notEmpty().withMessage('رابط الدورة مطلوب').isURL().withMessage('الرابط غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { title, description, price, is_free, education_level, course_url } = req.body;
        const teacherId = req.user.userId;

        if (!isTeraboxUrl(course_url)) {
            return res.status(400).json({
                success: false,
                error: 'رابط الدورة غير صالح. يجب أن يكون الرابط من منصة Terabox/1024terabox فقط.'
            });
        }

        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        const coursePrice = is_free === 'true' || is_free === true ? 0 : parseFloat(price);

        const courseData = {
            teacher_id: teacherId,
            title: title.trim(),
            description: description ? description.trim() : null,
            price: coursePrice,
            is_free: coursePrice === 0,
            education_level: education_level.trim(),
            course_url: course_url.trim(),
            status: 'published'
        };

        const course = await insert('courses', courseData);

        res.json({
            success: true,
            message: '✅ تم إنشاء الدورة بنجاح',
            course
        });
    } catch (error) {
        console.error('❌ خطأ في إنشاء الدورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب دورات أستاذ محدد
// ============================================================
router.get('/teacher/:teacher_id', [
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = parseInt(req.params.teacher_id);

        const { data, error } = await supabase
            .from('courses')
            .select('*')
            .eq('teacher_id', teacherId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ success: true, courses: data || [] });
    } catch (error) {
        console.error('❌ خطأ في جلب الدورات:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب جميع الدورات المنشورة (للطلاب والزوار)
// ============================================================
router.get('/public', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('courses')
            .select('*, teachers:teacher_id (full_name, specialization, profile_url)')
            .eq('status', 'published')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const formatted = (data || []).map(course => ({
            ...course,
            teacher_name: course.teachers?.full_name || 'غير معروف',
            teacher_specialization: course.teachers?.specialization || '',
            teacher_profile_url: course.teachers?.profile_url || null
        }));

        res.json({ success: true, courses: formatted });
    } catch (error) {
        console.error('❌ خطأ في جلب الدورات العامة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب دورة واحدة
// ============================================================
router.get('/:id', [
    param('id').isInt().withMessage('معرف الدورة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const courseId = parseInt(req.params.id);

        const { data, error } = await supabase
            .from('courses')
            .select('*, teachers:teacher_id (full_name, specialization, profile_url, bio)')
            .eq('id', courseId)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: 'الدورة غير موجودة' });
        }

        res.json({
            success: true,
            course: {
                ...data,
                teacher_name: data.teachers?.full_name || 'غير معروف',
                teacher_specialization: data.teachers?.specialization || '',
                teacher_profile_url: data.teachers?.profile_url || null,
                teacher_bio: data.teachers?.bio || ''
            }
        });
    } catch (error) {
        console.error('❌ خطأ في جلب الدورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ تحديث دورة (للأستاذ المالك فقط)
// ============================================================
router.put('/update/:id', authenticate, authorize(['teacher']), [
    param('id').isInt().withMessage('معرف الدورة غير صالح'),
    body('title').optional().isLength({ max: 200 }),
    body('price').optional().isFloat({ min: 0 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const courseId = parseInt(req.params.id);
        const teacherId = req.user.userId;

        const course = await getOne('courses', 'id', courseId);
        if (!course) {
            return res.status(404).json({ success: false, error: 'الدورة غير موجودة' });
        }

        if (course.teacher_id !== teacherId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتعديل هذه الدورة' });
        }

        const updateData = {};
        const allowedFields = ['title', 'description', 'price', 'is_free', 'education_level', 'course_url', 'status'];

        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                if (field === 'title') updateData.title = req.body.title.trim();
                else if (field === 'price') {
                    const p = parseFloat(req.body.price);
                    updateData.price = p;
                    updateData.is_free = p === 0;
                }
                else if (field === 'description') updateData.description = req.body.description ? req.body.description.trim() : null;
                else if (field === 'is_free') updateData.is_free = req.body.is_free === true || req.body.is_free === 'true';
                else if (field === 'course_url') {
                    if (!isTeraboxUrl(req.body.course_url)) {
                        return res.status(400).json({
                            success: false,
                            error: 'رابط الدورة غير صالح. يجب أن يكون الرابط من منصة Terabox/1024terabox فقط.'
                        });
                    }
                    updateData.course_url = req.body.course_url.trim();
                }
                else updateData[field] = req.body[field].trim();
            }
        }

        const updated = await update('courses', courseId, updateData);

        res.json({
            success: true,
            message: '✅ تم تحديث الدورة بنجاح',
            course: updated
        });
    } catch (error) {
        console.error('❌ خطأ في تحديث الدورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ حذف دورة (للأستاذ المالك فقط)
// ============================================================
router.delete('/delete/:id', authenticate, authorize(['teacher']), [
    param('id').isInt().withMessage('معرف الدورة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const courseId = parseInt(req.params.id);
        const teacherId = req.user.userId;

        const course = await getOne('courses', 'id', courseId);
        if (!course) {
            return res.status(404).json({ success: false, error: 'الدورة غير موجودة' });
        }

        if (course.teacher_id !== teacherId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذه الدورة' });
        }

        await remove('courses', 'id', courseId);

        res.json({ success: true, message: '✅ تم حذف الدورة بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في حذف الدورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
