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

        const coursePrice = is_free === 'true' || is_free === true ? 0 : parseFloat(price);
        const isVip = Boolean(teacher.is_vip === true && (!teacher.vip_expires_at || new Date(teacher.vip_expires_at) > new Date()));
        const courseStatus = isVip ? 'published' : 'pending';

        const courseData = {
            teacher_id: teacherId,
            title: title.trim(),
            description: description ? description.trim() : null,
            price: coursePrice,
            is_free: coursePrice === 0,
            education_level: education_level.trim(),
            course_url: course_url.trim(),
            status: courseStatus
        };

        const course = await insert('courses', courseData);

        res.json({
            success: true,
            message: isVip 
                ? '✅ تم إضافة ونشر دورتك تلقائياً وبنجاح دون مراجعة لأن حسابك مرقى ومميز (VIP)!'
                : '✅ تم إرسال الدورة بنجاح، وتوجد حالياً قيد المراجعة من قبل الإدارة.',
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
// ✅ جلب جميع الدورات المنشورة (للطلاب والزوار) - مع دعم التواتر والتقسيم (Batch Pagination)
// ============================================================
const handlePublicCourses = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = req.query.limit ? parseInt(req.query.limit) : 20;

        let data = null;
        try {
            const resQuery = await supabase
                .from('courses')
                .select('*, teachers:teacher_id (full_name, specialization, profile_image, profile_url, is_certified, is_vip, vip_expires_at, verification_status)')
                .eq('status', 'published')
                .order('created_at', { ascending: false });

            if (resQuery.error) throw resQuery.error;
            data = resQuery.data;
        } catch (joinErr) {
            logger.warn('⚠️ متعذر جلب الدورات بالربط مع الأساتذة، جاري الجلب المباشر:', joinErr?.message || joinErr);
            const resFallback = await supabase
                .from('courses')
                .select('*')
                .eq('status', 'published')
                .order('created_at', { ascending: false });

            if (resFallback.error) throw resFallback.error;
            data = resFallback.data;
        }

        const formatted = (data || []).map(course => {
            const views = getViewCount('course', course.id, course.views_count || course.views || 0);
            const teacherObj = course.teachers || {};
            const isVip = Boolean(teacherObj.is_vip === true && (!teacherObj.vip_expires_at || new Date(teacherObj.vip_expires_at) > new Date()));
            const isCert = Boolean(isVip || (teacherObj.is_certified === true && teacherObj.verification_status === 'approved'));
            return {
                ...course,
                views_count: views,
                views: views,
                teacher_name: course.teachers?.full_name || course.teacher_name || 'أستاذ',
                teacher_specialization: course.teachers?.specialization || 'أستاذ متميز',
                teacher_profile_image: course.teachers?.profile_url || (typeof getPublicImageUrl === 'function' ? getPublicImageUrl('profiles', 'teachers', course.teachers?.profile_image) : null) || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80',
                teacher_is_vip: isVip,
                teacher_is_certified: isCert,
                is_certified: isCert
            };
        });

        // 🏆 فرز الدورات: الأكثر مبيعات وتقييماً في الصدارة (مع إعطاء أولوية لـ VIP)
        formatted.sort((a, b) => {
            const aSales = Number(a.sales_count) || 0;
            const bSales = Number(b.sales_count) || 0;
            if (bSales !== aSales) return bSales - aSales;

            const aRating = Number(a.average_rating) || 0;
            const bRating = Number(b.average_rating) || 0;
            if (bRating !== aRating) return bRating - aRating;

            const aVip = a.teacher_is_vip ? 1 : 0;
            const bVip = b.teacher_is_vip ? 1 : 0;
            if (bVip !== aVip) return bVip - aVip;

            return new Date(b.created_at || 0) - new Date(a.created_at || 0);
        });

        // 📊 تقسيم النتيجة بتواتر (Batch Pagination)
        const total = formatted.length;
        let paginated = formatted;
        if (limit > 0 && limit < total) {
            const startIndex = (page - 1) * limit;
            paginated = formatted.slice(startIndex, startIndex + limit);
        }

        res.json({
            success: true,
            courses: paginated,
            total,
            page,
            limit,
            has_more: (page * limit) < total
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب الدورات العامة:', error.message);
        res.status(500).json({ success: false, courses: [], error: 'حدث خطأ في الخادم' });
    }
};

router.get('/', handlePublicCourses);
router.get('/public', handlePublicCourses);

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
// ✅ جلب قائمة الدورات المشتراة للطالب (يجب أن يكون قبل /:id)
// ============================================================
router.get('/my-purchases', authenticate, authorize(['student']), async (req, res) => {
    try {
        const studentId = parseInt(req.user.userId);
        const { data, error } = await supabase
            .from('course_purchases')
            .select('course_id')
            .eq('student_id', studentId);

        if (error) {
            logger.error('❌ خطأ في جلب المشتريات لـ student_id=' + studentId + ':', error);
            return res.json({ success: true, purchases: [] });
        }

        const purchasedIds = (data || []).map(p => p.course_id);
        logger.info('📦 المشتريات المجلوبة لـ student_id=' + studentId + ':', purchasedIds);
        res.json({ success: true, purchases: purchasedIds });
    } catch (error) {
        logger.error('❌ استثناء في جلب المشتريات:', error.message);
        res.json({ success: true, purchases: [] });
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
            const { data: updateRes, error: updateErr } = await supabase.from('students').update({
                wallet_balance: newStudentBalance,
                updated_at: new Date().toISOString()
            }).eq('id', studentId).eq('wallet_balance', student.wallet_balance || 0).select();

            if (updateErr || !updateRes || updateRes.length === 0) {
                return res.status(409).json({ success: false, error: 'حدث تغيير في الرصيد أثناء المعالجة، يرجى المحاولة مرة أخرى' });
            }

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
            const purchaseRecord = {
                course_id: parseInt(courseId),
                student_id: parseInt(studentId),
                teacher_id: parseInt(course.teacher_id),
                price: parseFloat(coursePrice),
                platform_commission: parseFloat(platformCommission),
                teacher_earned: parseFloat(teacherEarned),
                created_at: new Date().toISOString()
            };

            logger.info('⏳ جاري تسجيل عملية الشراء في قاعدة البيانات:', purchaseRecord);
            const { data: pInsertData, error: pInsertError } = await supabase
                .from('course_purchases')
                .insert(purchaseRecord)
                .select();

            if (pInsertError) {
                logger.error('❌ فشل تسجيل الشراء في جدول course_purchases:', pInsertError);
                // تراجع عن المعاملة (إرجاع رصيد الطالب) لتجنب ضياع الأموال
                try {
                    await supabase.from('students').update({
                        wallet_balance: studentBalance,
                        updated_at: new Date().toISOString()
                    }).eq('id', studentId);
                } catch (rollbackErr) {
                    logger.error('❌ فشل التراجع عن خصم الرصيد:', rollbackErr.message);
                }
                return res.status(500).json({ 
                    success: false, 
                    error: `فشل تسجيل شراء الدورة في قاعدة البيانات: ${pInsertError.message || JSON.stringify(pInsertError)}` 
                });
            }
            logger.info('✅ تم تسجيل الشراء بنجاح:', pInsertData);

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
            const purchaseRecord = {
                course_id: parseInt(courseId),
                student_id: parseInt(studentId),
                teacher_id: parseInt(course.teacher_id),
                price: 0,
                platform_commission: 0,
                teacher_earned: 0,
                created_at: new Date().toISOString()
            };

            logger.info('⏳ جاري تسجيل الاشتراك في الدورة المجانية:', purchaseRecord);
            const { error: pInsertError } = await supabase
                .from('course_purchases')
                .insert(purchaseRecord);

            if (pInsertError) {
                logger.error('❌ فشل تسجيل الاشتراك في الدورة المجانية:', pInsertError);
                return res.status(500).json({ 
                    success: false, 
                    error: `فشل تسجيل الاشتراك في الدورة المجانية: ${pInsertError.message || JSON.stringify(pInsertError)}` 
                });
            }
            logger.info('✅ تم تسجيل الاشتراك في الدورة المجانية بنجاح');
        }

        // 📈 زيادة عداد مبيعات الدورة
        try {
            const currentSales = Number(course.sales_count) || 0;
            await update('courses', courseId, { sales_count: currentSales + 1 });
        } catch (salesErr) {
            logger.warn('⚠️ فشل تحديث عداد مبيعات الدورة:', salesErr.message);
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
// ⭐ تقييم الدورة (للطالب المشترك)
// ============================================================
router.post('/rate/:id', authenticate, authorize(['student']), [
    param('id').isInt().withMessage('معرف الدورة غير صالح'),
    body('rating').isInt({ min: 1, max: 5 }).withMessage('التقييم يجب أن يكون من 1 إلى 5 نجوم')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, error: errors.array()[0].msg });
        }

        const courseId = parseInt(req.params.id);
        const studentId = parseInt(req.user.userId);
        const { rating, review = '' } = req.body;

        const course = await getOne('courses', 'id', courseId);
        if (!course) {
            return res.status(404).json({ success: false, error: 'الدورة غير موجودة' });
        }

        // التحقق من شراء الطالب للدورة أو كونها مجانية
        const { data: purchase } = await supabase
            .from('course_purchases')
            .select('*')
            .eq('course_id', courseId)
            .eq('student_id', studentId)
            .maybeSingle();

        if (!purchase && !course.is_free) {
            return res.status(403).json({ success: false, error: 'يجب أن تكون قد اشتركت في الدورة لتتمكن من تقييمها' });
        }

        // التحقق من التقييم السابق (مرة واحدة فقط)
        const { data: existingRating } = await supabase
            .from('course_ratings')
            .select('*')
            .eq('course_id', courseId)
            .eq('student_id', studentId)
            .maybeSingle();

        if (existingRating) {
            return res.status(400).json({ success: false, error: 'لقد قمت بتقييم هذه الدورة سابقاً. التقييم مسموح به لمرة واحدة فقط.' });
        }

        await supabase.from('course_ratings').insert({
            course_id: courseId,
            student_id: studentId,
            rating: parseInt(rating),
            review: review.trim(),
            created_at: new Date().toISOString()
        });

        // إعادة حساب متوسط التقييمات وعددها
        const { data: ratingsData } = await supabase
            .from('course_ratings')
            .select('rating')
            .eq('course_id', courseId);

        const rCount = ratingsData ? ratingsData.length : 0;
        const rSum = ratingsData ? ratingsData.reduce((acc, r) => acc + (r.rating || 0), 0) : 0;
        const avgRating = rCount > 0 ? Math.round((rSum / rCount) * 10) / 10 : 0;

        await update('courses', courseId, {
            average_rating: avgRating,
            ratings_count: rCount,
            updated_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: '🌟 شكراً لك! تم تسجيل تقييمك للدورة بنجاح.',
            average_rating: avgRating,
            ratings_count: rCount
        });
    } catch (error) {
        logger.error('❌ خطأ في تقييم الدورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء تسجيل التقييم' });
    }
});

// ============================================================
// ⭐ جلب تقييم الطالب الحالي للدورة
// ============================================================
router.get('/:id/my-rating', authenticate, authorize(['student']), async (req, res) => {
    try {
        const courseId = parseInt(req.params.id);
        const studentId = parseInt(req.user.userId);

        const { data: ratingRow } = await supabase
            .from('course_ratings')
            .select('*')
            .eq('course_id', courseId)
            .eq('student_id', studentId)
            .maybeSingle();

        res.json({
            success: true,
            has_rated: !!ratingRow,
            rating: ratingRow || null
        });
    } catch (error) {
        res.json({ success: true, has_rated: false, rating: null });
    }
});

// ============================================================
// ⭐ جلب تقييمات ومراجعات دورة محددة مع أسماء الطلاب (للأساتذة والطلاب)
// ============================================================
router.get('/:id/reviews', async (req, res) => {
    try {
        const courseId = parseInt(req.params.id);
        if (isNaN(courseId)) {
            return res.status(400).json({ success: false, error: 'معرف الدورة غير صالح' });
        }

        const { data: ratings, error } = await supabase
            .from('course_ratings')
            .select(`
                id,
                rating,
                review,
                created_at,
                students:student_id (
                    id,
                    full_name,
                    profile_image,
                    profile_url
                )
            `)
            .eq('course_id', courseId)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('❌ خطأ في جلب تقييمات الدورة:', error.message);
            return res.status(500).json({ success: false, error: 'فشل جلب التقييمات والمراجعات' });
        }

        const formattedReviews = (ratings || []).map(r => ({
            id: r.id,
            rating: r.rating,
            review: r.review,
            created_at: r.created_at,
            student_name: r.students?.full_name || 'طالب بالمنصة',
            student_image: r.students?.profile_url || (r.students?.profile_image ? (typeof getPublicImageUrl === 'function' ? getPublicImageUrl('profiles', 'students', r.students.profile_image) : null) : null) || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'
        }));

        res.json({
            success: true,
            reviews: formattedReviews
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب مراجعات الدورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
