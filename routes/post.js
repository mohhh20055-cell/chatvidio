// ============================================================
// مسارات المنشورات - Post Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');

const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');
const { uploadToSupabase, validateUploadedFiles } = require('../utils/upload');

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

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بنشر هذا المنشور' });
        }

        let image_url = null, file_url = null;

        if (req.files?.['image']?.[0]) {
            const uploaded = await uploadToSupabase(req.files['image'][0], 'posts');
            if (uploaded) image_url = uploaded.url;
        }
        if (req.files?.['file']?.[0]) {
            const uploaded = await uploadToSupabase(req.files['file'][0], 'files');
            if (uploaded) file_url = uploaded.url;
        }

        await insert('posts', {
            teacher_id: parseInt(teacher_id),
            title: title.trim(),
            content: content.trim(),
            image_url,
            file_url,
            link_url: link_url?.trim() || null,
            likes: 0,
            created_at: new Date().toISOString()
        });

        res.json({ success: true, message: 'تم نشر الدرس بنجاح' });
    } catch (error) {
        console.error('خطأ في إنشاء المنشور:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب منشورات الأستاذ
// ============================================================
router.get('/:teacher_id', async (req, res) => {
    try {
        const { data } = await supabase
            .from('posts')
            .select('*')
            .eq('teacher_id', req.params.teacher_id)
            .order('created_at', { ascending: false });

        const postsWithCounts = await Promise.all((data || []).map(async (post) => {
            const { count: likesCount } = await supabase
                .from('post_likes')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id);

            const { count: commentsCount } = await supabase
                .from('post_comments')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id);

            return { ...post, likes_count: likesCount || 0, comments_count: commentsCount || 0 };
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
        const { data: post } = await supabase
            .from('posts')
            .select('*, teachers:teacher_id (full_name, profile_url)')
            .eq('id', req.params.post_id)
            .single();

        if (!post) return res.status(404).json({ error: 'المنشور غير موجود' });

        const { data: comments } = await supabase
            .from('post_comments')
            .select('*, students:student_id (full_name, profile_url)')
            .eq('post_id', req.params.post_id)
            .order('created_at', { ascending: true });

        res.json({
            ...post,
            teacher_name: post.teachers?.full_name,
            teacher_image: post.teachers?.profile_url,
            comments: comments || []
        });
    } catch (error) {
        console.error('خطأ في جلب المنشور:', error.message);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
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

        await insert('post_likes', { post_id, student_id });

        const { count } = await supabase
            .from('post_likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        await update('posts', post_id, { likes: count });
        res.json({ success: true, liked: true });
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

        await supabase.from('post_likes').delete().eq('post_id', post_id).eq('student_id', student_id);

        const { count } = await supabase
            .from('post_likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        await update('posts', post_id, { likes: count });
        res.json({ success: true, liked: false });
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
        const { post_id, student_id } = req.params;

        if (req.user.userId !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data } = await supabase
            .from('post_likes')
            .select('*')
            .eq('post_id', post_id)
            .eq('student_id', student_id)
            .single();
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

        await insert('post_comments', {
            post_id,
            student_id,
            comment: comment.trim(),
            created_at: new Date().toISOString()
        });

        const { count } = await supabase
            .from('post_comments')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        await update('posts', post_id, { comments_count: count });
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في إضافة تعليق:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// حذف تعليق
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

        const { comment_id } = req.params;
        const { teacher_id, post_id } = req.body;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const post = await getOne('posts', 'id', post_id);
        if (!post || post.teacher_id != teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        await remove('post_comments', 'id', comment_id);
        res.json({ success: true });
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

        const { post_id } = req.params;
        const { teacher_id } = req.body;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const post = await getOne('posts', 'id', post_id);
        if (!post || post.teacher_id != teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        await supabase.from('post_likes').delete().eq('post_id', post_id);
        await supabase.from('post_comments').delete().eq('post_id', post_id);
        await remove('posts', 'id', post_id);
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في حذف المنشور:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
