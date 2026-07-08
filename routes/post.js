// ============================================================
// مسارات المنشورات - Post Routes (معدل بالكامل)
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

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];
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
// إنشاء منشور
// ============================================================
router.post('/create', authenticate, authorize(['teacher']), upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]), validateUploadedFiles, [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('title').notEmpty().withMessage('العنوان مطلوب').isLength({ max: 200 }),
    body('content').notEmpty().withMessage('المحتوى مطلوب').isLength({ max: 5000 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, title, content, link_url } = req.body;

        // ✅ التحقق من الصلاحية
        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بنشر هذا المنشور' });
        }

        // ✅ التحقق من وجود الأستاذ
        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        let image_url = null;
        let file_url = null;

        // ✅ رفع الصورة
        if (req.files && req.files['image'] && req.files['image'][0]) {
            const uploaded = await uploadToSupabase(req.files['image'][0], 'posts');
            if (uploaded) {
                image_url = uploaded.url;
            }
        }

        // ✅ رفع الملف
        if (req.files && req.files['file'] && req.files['file'][0]) {
            const uploaded = await uploadToSupabase(req.files['file'][0], 'files');
            if (uploaded) {
                file_url = uploaded.url;
            }
        }

        // ✅ إنشاء المنشور
        const newPost = await insert('posts', {
            teacher_id: parseInt(teacher_id),
            title: title.trim(),
            content: content.trim(),
            image_url,
            file_url,
            link_url: link_url?.trim() || null,
            likes: 0,
            comments_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        // ✅ إرسال إشعار للطلاب المتابعين
        try {
            // جلب الطلاب الذين حجزوا عروض هذا الأستاذ
            const { data: students } = await supabase
                .from('sessions')
                .select('student_id')
                .eq('teacher_id', teacher_id)
                .eq('payment_status', 'paid')
                .order('created_at', { ascending: false })
                .limit(100);

            if (students && students.length > 0) {
                const uniqueStudents = [...new Set(students.map(s => s.student_id))];
                
                // إرسال إشعار لكل طالب
                const notifications = uniqueStudents.map(student_id => ({
                    user_id: student_id,
                    user_type: 'student',
                    title: `📚 درس جديد من الأستاذ ${teacher.full_name || 'غير معروف'}`,
                    message: `${title}`,
                    post_id: newPost.id,
                    is_read: false,
                    created_at: new Date().toISOString()
                }));

                if (notifications.length > 0) {
                    await supabase
                        .from('notifications')
                        .insert(notifications);
                }
            }
        } catch (notifyError) {
            console.error('خطأ في إرسال الإشعارات:', notifyError.message);
        }

        res.json({ 
            success: true, 
            message: 'تم نشر الدرس بنجاح',
            post: newPost
        });
    } catch (error) {
        console.error('خطأ في إنشاء المنشور:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب منشورات الأستاذ
// ============================================================
router.get('/:teacher_id', async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);

        const { data, error } = await supabase
            .from('posts')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // ✅ جلب عدد الإعجابات والتعليقات لكل منشور
        const postsWithCounts = await Promise.all((data || []).map(async (post) => {
            const { count: likesCount } = await supabase
                .from('post_likes')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id);

            const { count: commentsCount } = await supabase
                .from('post_comments')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id);

            return { 
                ...post, 
                likes_count: likesCount || 0, 
                comments_count: commentsCount || 0 
            };
        }));

        res.json(postsWithCounts);
    } catch (error) {
        console.error('خطأ في جلب منشورات الأستاذ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب منشور مع التعليقات
// ============================================================
router.get('/post/:post_id', async (req, res) => {
    try {
        const post_id = parseInt(req.params.post_id);

        const { data: post, error: postError } = await supabase
            .from('posts')
            .select('*, teachers:teacher_id (id, full_name, profile_url, specialization)')
            .eq('id', post_id)
            .single();

        if (postError || !post) {
            return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
        }

        // ✅ جلب التعليقات مع معلومات الطلاب
        const { data: comments, error: commentsError } = await supabase
            .from('post_comments')
            .select('*, students:student_id (id, full_name, profile_url)')
            .eq('post_id', post_id)
            .order('created_at', { ascending: true });

        if (commentsError) {
            console.error('خطأ في جلب التعليقات:', commentsError.message);
        }

        // ✅ جلب عدد الإعجابات
        const { count: likesCount } = await supabase
            .from('post_likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        res.json({
            success: true,
            ...post,
            teacher_name: post.teachers?.full_name || 'غير معروف',
            teacher_image: post.teachers?.profile_url || null,
            teacher_specialization: post.teachers?.specialization || '',
            likes_count: likesCount || 0,
            comments: comments || []
        });
    } catch (error) {
        console.error('خطأ في جلب المنشور:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إعجاب بمنشور
// ============================================================
router.post('/like', authenticate, authorize(['student']), [
    body('post_id').isInt().withMessage('معرف المنشور غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { post_id, student_id } = req.body;

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ التحقق من وجود المنشور
        const post = await getOne('posts', 'id', post_id);
        if (!post) {
            return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
        }

        // ✅ التحقق من عدم وجود إعجاب مسبق
        const { data: existing } = await supabase
            .from('post_likes')
            .select('id')
            .eq('post_id', post_id)
            .eq('student_id', student_id)
            .single();

        if (existing) {
            return res.status(400).json({ success: false, error: 'لقد قمت بالإعجاب بالفعل' });
        }

        // ✅ إضافة الإعجاب
        await insert('post_likes', { 
            post_id, 
            student_id,
            created_at: new Date().toISOString()
        });

        // ✅ تحديث عدد الإعجابات
        const { count } = await supabase
            .from('post_likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        await update('posts', post_id, { 
            likes: count,
            updated_at: new Date().toISOString()
        });

        res.json({ 
            success: true, 
            liked: true,
            likes_count: count
        });
    } catch (error) {
        console.error('خطأ في الإعجاب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إلغاء الإعجاب
// ============================================================
router.post('/unlike', authenticate, authorize(['student']), [
    body('post_id').isInt().withMessage('معرف المنشور غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { post_id, student_id } = req.body;

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ حذف الإعجاب
        await supabase
            .from('post_likes')
            .delete()
            .eq('post_id', post_id)
            .eq('student_id', student_id);

        // ✅ تحديث عدد الإعجابات
        const { count } = await supabase
            .from('post_likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        await update('posts', post_id, { 
            likes: count,
            updated_at: new Date().toISOString()
        });

        res.json({ 
            success: true, 
            liked: false,
            likes_count: count
        });
    } catch (error) {
        console.error('خطأ في إلغاء الإعجاب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// التحقق من الإعجاب
// ============================================================
router.get('/check-like/:post_id/:student_id', authenticate, authorize(['student']), async (req, res) => {
    try {
        const post_id = parseInt(req.params.post_id);
        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data, error } = await supabase
            .from('post_likes')
            .select('id')
            .eq('post_id', post_id)
            .eq('student_id', student_id)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw error;
        }

        res.json({ liked: !!data });
    } catch (error) {
        console.error('خطأ في التحقق من الإعجاب:', error.message);
        res.json({ liked: false });
    }
});

// ============================================================
// إضافة تعليق
// ============================================================
router.post('/comment', authenticate, authorize(['student']), [
    body('post_id').isInt().withMessage('معرف المنشور غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح'),
    body('comment').notEmpty().withMessage('التعليق مطلوب').isLength({ max: 1000 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { post_id, student_id, comment } = req.body;

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ التحقق من وجود المنشور
        const post = await getOne('posts', 'id', post_id);
        if (!post) {
            return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
        }

        // ✅ إضافة التعليق
        const newComment = await insert('post_comments', {
            post_id,
            student_id,
            comment: comment.trim(),
            created_at: new Date().toISOString()
        });

        // ✅ تحديث عدد التعليقات
        const { count } = await supabase
            .from('post_comments')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        await update('posts', post_id, { 
            comments_count: count,
            updated_at: new Date().toISOString()
        });

        // ✅ جلب معلومات الطالب
        const student = await getOne('students', 'id', student_id);

        res.json({ 
            success: true,
            comment: {
                ...newComment,
                students: {
                    full_name: student?.full_name || 'طالب',
                    profile_url: student?.profile_url || null
                }
            }
        });
    } catch (error) {
        console.error('خطأ في إضافة تعليق:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// حذف تعليق (للمدرس فقط)
// ============================================================
router.delete('/comment/:comment_id', authenticate, authorize(['teacher']), [
    param('comment_id').isInt().withMessage('معرف التعليق غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('post_id').isInt().withMessage('معرف المنشور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const comment_id = parseInt(req.params.comment_id);
        const { teacher_id, post_id } = req.body;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ التحقق من أن المنشور يعود للمدرس
        const post = await getOne('posts', 'id', post_id);
        if (!post || post.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذا التعليق' });
        }

        // ✅ حذف التعليق
        await remove('post_comments', 'id', comment_id);

        // ✅ تحديث عدد التعليقات
        const { count } = await supabase
            .from('post_comments')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        await update('posts', post_id, { 
            comments_count: count,
            updated_at: new Date().toISOString()
        });

        res.json({ success: true, message: 'تم حذف التعليق بنجاح' });
    } catch (error) {
        console.error('خطأ في حذف تعليق:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// حذف منشور
// ============================================================
router.delete('/:post_id', authenticate, authorize(['teacher']), [
    param('post_id').isInt().withMessage('معرف المنشور غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const post_id = parseInt(req.params.post_id);
        const { teacher_id } = req.body;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ التحقق من وجود المنشور
        const post = await getOne('posts', 'id', post_id);
        if (!post) {
            return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
        }

        if (post.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذا المنشور' });
        }

        // ✅ حذف جميع البيانات المرتبطة
        await supabase.from('post_likes').delete().eq('post_id', post_id);
        await supabase.from('post_comments').delete().eq('post_id', post_id);
        
        // ✅ حذف المنشور
        await remove('posts', 'id', post_id);

        res.json({ 
            success: true, 
            message: 'تم حذف المنشور وجميع البيانات المرتبطة به بنجاح' 
        });
    } catch (error) {
        console.error('خطأ في حذف المنشور:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب جميع المنشورات (للطلاب)
// ============================================================
router.get('/', async (req, res) => {
    try {
        const { limit = 20, offset = 0 } = req.query;

        const { data, error } = await supabase
            .from('posts')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_url)')
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (error) throw error;

        // ✅ جلب عدد الإعجابات والتعليقات لكل منشور
        const postsWithCounts = await Promise.all((data || []).map(async (post) => {
            const { count: likesCount } = await supabase
                .from('post_likes')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id);

            const { count: commentsCount } = await supabase
                .from('post_comments')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id);

            return {
                ...post,
                teacher_name: post.teachers?.full_name || 'غير معروف',
                teacher_specialization: post.teachers?.specialization || '',
                teacher_profile_url: post.teachers?.profile_url || null,
                likes_count: likesCount || 0,
                comments_count: commentsCount || 0
            };
        }));

        res.json(postsWithCounts);
    } catch (error) {
        console.error('خطأ في جلب المنشورات:', error.message);
        res.status(500).json([]);
    }
});

module.exports = router;
