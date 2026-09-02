const logger = require('../utils/logger');
// ============================================================
// مسارات الدورات - Course Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { supabase } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');
const { getPublicImageUrl, uploadToSupabase } = require('../utils/upload');
const { getViewCount } = require('../utils/viewsTracker');
const multer = require('multer');
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

// ============================================================
// ✅ إنشاء دورة جديدة (للأستاذ فقط)
// ============================================================
router.post('/create', authenticate, authorize(['teacher']), upload.single('thumbnail'), [
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

        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        let thumbnailUrl = req.body.thumbnail_url || null;
        if (req.file) {
            try {
                const uploadRes = await uploadToSupabase(req.file, 'thumbnails');
                if (uploadRes && uploadRes.url) {
                    thumbnailUrl = uploadRes.url;
                }
            } catch (upErr) {
                logger.warn('⚠️ فشل رفع الصورة المصغرة للدورة:', upErr.message);
            }
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
            thumbnail_url: thumbnailUrl,
            image_url: thumbnailUrl,
            status: 'pending'
        };

        const course = await insert('courses', courseData);

        res.json({
            success: true,
            message: '✅ تم إرسال الدورة بنجاح، وتوجد حالياً قيد المراجعة من قبل الإدارة.',
            course
        });
    } catch (error) {
        logger.error('❌ خطأ في إنشاء الدورة:', error.message);
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

        const formattedCourses = (data || []).map(course => {
            const views = getViewCount('course', course.id, course.views_count || course.views || 0);
            return {
                ...course,
                views_count: views,
                views: views
            };
        });

        res.json({ success: true, courses: formattedCourses });
    } catch (error) {
        logger.error('❌ خطأ في جلب الدورات:', error.message);
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
            .select('*, teachers:teacher_id (full_name, specialization, profile_image, profile_url)')
            .eq('status', 'published')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const formatted = (data || []).map(course => {
            const views = getViewCount('course', course.id, course.views_count || course.views || 0);
            return {
                ...course,
                views_count: views,
                views: views,
                teacher_name: course.teachers?.full_name || 'أستاذ معتمد ZoomDz',
                teacher_specialization: course.teachers?.specialization || 'أستاذ متميز',
                teacher_profile_image: course.teachers?.profile_url || getPublicImageUrl('profiles', 'teachers', course.teachers?.profile_image) || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'
            };
        });

        res.json({ success: true, courses: formatted });
    } catch (error) {
        logger.error('❌ خطأ في جلب الدورات العامة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ عدد الدورات الجديدة غير المشاهدة (يجب أن يكون قبل /:id)
// ============================================================
router.get('/unread-count', async (req, res) => {
    try {
        const { last_viewed } = req.query;

        let query = supabase
            .from('courses')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'approved');

        if (last_viewed && last_viewed !== 'null' && last_viewed !== 'undefined' && last_viewed !== '') {
            query = query.gt('created_at', last_viewed);
        } else {
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            query = query.gt('created_at', oneDayAgo);
        }

        const { count, error: countErr } = await query;
        if (countErr && countErr.code !== 'PGRST116') throw countErr;

        res.json({
            success: true,
            unread_count: count || 0
        });
    } catch (error) {
        logger.error('Error getting unread courses count:', error.message);
        res.json({ success: true, unread_count: 0 });
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
            .select('*, teachers:teacher_id (full_name, specialization, profile_image, profile_url, bio)')
            .eq('id', courseId)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: 'الدورة غير موجودة' });
        }

        const views = getViewCount('course', data.id, data.views_count || data.views || 0);

        res.json({
            success: true,
            course: {
                ...data,
                views_count: views,
                views: views,
                teacher_name: data.teachers?.full_name || 'غير معروف',
                teacher_specialization: data.teachers?.specialization || '',
                teacher_profile_image: data.teachers?.profile_url || getPublicImageUrl('profiles', 'teachers', data.teachers?.profile_image) || null,
                teacher_bio: data.teachers?.bio || ''
            }
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب الدورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ تحديث دورة (للأستاذ المالك فقط)
// ============================================================
router.put('/update/:id', authenticate, authorize(['teacher']), upload.single('thumbnail'), [
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
                    updateData.course_url = req.body.course_url.trim();
                }
                else updateData[field] = req.body[field].trim();
            }
        }

        if (req.file) {
            try {
                const uploadRes = await uploadToSupabase(req.file, 'thumbnails');
                if (uploadRes && uploadRes.url) {
                    updateData.thumbnail_url = uploadRes.url;
                    updateData.image_url = uploadRes.url;
                }
            } catch (upErr) {
                logger.warn('⚠️ فشل تحديث الصورة المصغرة للدورة:', upErr.message);
            }
        } else if (req.body.thumbnail_url) {
            updateData.thumbnail_url = req.body.thumbnail_url;
            updateData.image_url = req.body.thumbnail_url;
        }

        const updated = await update('courses', courseId, updateData);

        res.json({
            success: true,
            message: '✅ تم تحديث الدورة بنجاح',
            course: updated
        });
    } catch (error) {
        logger.error('❌ خطأ في تحديث الدورة:', error.message);
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
        logger.error('❌ خطأ في حذف الدورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ عدد الدورات الجديدة غير المشاهدة
// ============================================================
router.get('/unread-count', async (req, res) => {
    try {
        const { last_viewed } = req.query;

        let query = supabase
            .from('courses')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'approved');

        if (last_viewed && last_viewed !== 'null' && last_viewed !== 'undefined' && last_viewed !== '') {
            query = query.gt('created_at', last_viewed);
        } else {
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            query = query.gt('created_at', oneDayAgo);
        }

        const { count, error: countErr } = await query;
        if (countErr && countErr.code !== 'PGRST116') throw countErr;

        res.json({
            success: true,
            unread_count: count || 0
        });
    } catch (error) {
        logger.error('Error getting unread courses count:', error.message);
        res.json({ success: true, unread_count: 0 });
    }
});

// ============================================================
// ✅ شراء دورة (خصم من رصيد الطالب واقتطاع عمولة المنصة 20% للأستاذ)
// ============================================================
router.post('/buy/:id', authenticate, authorize(['student']), async (req, res) => {
    try {
        const courseId = parseInt(req.params.id);
        const studentId = req.user.userId;

        if (!courseId || isNaN(courseId)) {
            return res.status(400).json({ success: false, error: 'معرف الدورة غير صالح' });
        }

        const course = await getOne('courses', 'id', courseId);
        if (!course) {
            return res.status(404).json({ success: false, error: 'الدورة غير موجودة' });
        }

        // التحقق مما إذا كان الطالب قد اشترى الدورة سابقاً
        const { data: existingPurchase } = await supabase
            .from('course_purchases')
            .select('*')
            .eq('course_id', courseId)
            .eq('student_id', studentId)
            .maybeSingle();

        if (existingPurchase) {
            return res.json({
                success: true,
                message: 'أنت مشترك بالفعل في هذه الدورة',
                course_url: course.course_url,
                already_purchased: true
            });
        }

        const coursePrice = parseFloat(course.price || 0);
        const isFree = course.is_free === true || coursePrice === 0;

        const student = await getOne('students', 'id', studentId);
        if (!student) {
            return res.status(404).json({ success: false, error: 'حساب الطالب غير موجود' });
        }

        if (!isFree) {
            const studentBalance = parseFloat(student.wallet_balance || 0);
            if (studentBalance < coursePrice) {
                return res.status(400).json({
                    success: false,
                    error: `رصيدك غير كافٍ لشراء هذه الدورة. رصيدك الحالي: ${studentBalance} دج (سعر الدورة: ${coursePrice} دج)`,
                    insufficient_balance: true,
                    needed: coursePrice - studentBalance
                });
            }

            // اقتطاع 20% عمولة للمنصة و 80% للأستاذ
            const platformCommission = Math.round(coursePrice * 0.20);
            const teacherEarned = coursePrice - platformCommission;

            // 1. خصم من محفظة الطالب
            const newStudentBalance = studentBalance - coursePrice;
            await update('students', studentId, {
                wallet_balance: newStudentBalance,
                updated_at: new Date().toISOString()
            });

            // 2. إضافة رصيد الأستاذ (80% من المبيعة)
            const teacher = await getOne('teachers', 'id', course.teacher_id);
            if (teacher) {
                const newTeacherBalance = (parseFloat(teacher.balance) || 0) + teacherEarned;
                const newTeacherTotalEarned = (parseFloat(teacher.total_earned) || 0) + teacherEarned;
                await update('teachers', course.teacher_id, {
                    balance: newTeacherBalance,
                    total_earned: newTeacherTotalEarned,
                    updated_at: new Date().toISOString()
                });
            }

            // 3. تسجيل معاملة المحفظة للطالب
            await insert('wallet_transactions', {
                student_id: studentId,
                amount: coursePrice,
                type: 'withdraw',
                status: 'completed',
                description: `شراء دورة "${course.title}" (اقتطاع 20% عمولة المنصة)`,
                created_at: new Date().toISOString()
            });

            // 4. تسجيل الشراء في جدول course_purchases
            try {
                await supabase.from('course_purchases').insert({
                    course_id: courseId,
                    student_id: studentId,
                    teacher_id: course.teacher_id,
                    price: coursePrice,
                    platform_commission: platformCommission,
                    teacher_earned: teacherEarned,
                    created_at: new Date().toISOString()
                });
            } catch (pErr) {
                console.warn('⚠️ تعذر إدخال course_purchases:', pErr.message);
            }

            // 5. إشعار الأستاذ
            await supabase.from('notifications').insert({
                user_id: course.teacher_id,
                user_type: 'teacher',
                title: '💰 مبيعة جديدة لدورة (عمولة 20%)',
                message: `قام طالب بشراء دورتك "${course.title}". تم إضافة ${teacherEarned} دج لأرباحك بعد اقتطاع عمولة المنصة (20% = ${platformCommission} دج).`,
                is_read: false,
                created_at: new Date().toISOString()
            });

            // 6. إشعار الطالب
            await supabase.from('notifications').insert({
                user_id: studentId,
                user_type: 'student',
                title: '🎉 تم شراء الدورة بنجاح',
                message: `لقد قمت بشراء دورة "${course.title}" بمبلغ ${coursePrice} دج. يمكنك الآن الوصول إلى رابط ومحتوى الدورة.`,
                is_read: false,
                created_at: new Date().toISOString()
            });
        } else {
            // دورة مجانية
            try {
                await supabase.from('course_purchases').insert({
                    course_id: courseId,
                    student_id: studentId,
                    teacher_id: course.teacher_id,
                    price: 0,
                    platform_commission: 0,
                    teacher_earned: 0,
                    created_at: new Date().toISOString()
                });
            } catch (pErr) {}
        }

        res.json({
            success: true,
            message: '🎉 تم الاشتراك في الدورة بنجاح!',
            course_url: course.course_url
        });
    } catch (error) {
        logger.error('❌ خطأ في شراء الدورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في إجراء عملية الشراء' });
    }
});

// ============================================================
// ✅ جلب قائمة الدورات المشتراة للطالب
// ============================================================
router.get('/my-purchases', authenticate, authorize(['student']), async (req, res) => {
    try {
        const studentId = req.user.userId;
        const { data, error } = await supabase
            .from('course_purchases')
            .select('course_id')
            .eq('student_id', studentId);

        if (error) {
            return res.json({ success: true, purchases: [] });
        }

        const purchasedIds = (data || []).map(p => p.course_id);
        res.json({ success: true, purchases: purchasedIds });
    } catch (error) {
        res.json({ success: true, purchases: [] });
    }
});

module.exports = router;
