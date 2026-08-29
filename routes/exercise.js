// ============================================================
// مسارات التمارين والحلول - Exercises & Solutions Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { supabase } = require('../config/database');
const { authenticate, optionalAuth, authorize } = require('../middleware/auth');
const { getOne, insert, remove, update } = require('../utils/helpers');
const { uploadToSupabase } = require('../utils/upload');
const logger = require('../utils/logger');

// ============================================================
// 1.5. رفع ملف PDF (للأساتذة فقط)
// ============================================================
router.post('/get-signed-upload-url', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const { fileName, contentType } = req.body;
        const fileExt = fileName.split('.').pop();
        const uniqueFileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
        const filePath = `exercises/${uniqueFileName}`;
        
        const { data, error } = await supabase.storage.from('exercises').createSignedUploadUrl(filePath);
        
        if (error) throw error;
        
        res.json({ success: true, url: data.signedUrl, path: filePath });
    } catch (err) {
        logger.error('❌ خطأ في توليد رابط الرفع:', err.message);
        res.status(500).json({ error: 'حدث خطأ أثناء إعداد الرفع' });
    }
});

// ============================================================
// 1. جلب قائمة التمارين والحلول (تطبيق الفلترة، البحث، والمحفوظات)
// ============================================================
router.get('/', optionalAuth, async (req, res) => {
    try {
        const { level, search, saved_only } = req.query;
        const currentUserId = req.user ? (req.user.userId || req.user.id) : null;
        const currentUserType = req.user ? req.user.role : null;

        // جلب التمارين المحفوظة إذا كان الطالب يطلب المحفوظات فقط
        let savedExerciseIds = [];
        if (currentUserId && (saved_only === 'true' || saved_only === true)) {
            try {
                const { data: savedData } = await supabase
                    .from('exercise_bookmarks')
                    .select('exercise_id')
                    .eq('user_id', currentUserId)
                    .eq('user_type', currentUserType);
                
                if (savedData && Array.isArray(savedData)) {
                    savedExerciseIds = savedData.map(b => b.exercise_id);
                }
            } catch (err) {
                logger.warn('لم يتم العثور على جدول exercise_bookmarks في Supabase أو أنه فارغ');
            }

            if (savedExerciseIds.length === 0) {
                return res.json([]);
            }
        }

        // بناء استعلام Supabase
        let query = supabase
            .from('exercise_posts')
            .select('*')
            .order('created_at', { ascending: false });

        if (saved_only === 'true' && savedExerciseIds.length > 0) {
            query = query.in('id', savedExerciseIds);
        }

        const { data: rawExercises, error } = await query;

        if (error && error.code !== 'PGRST116') {
            logger.warn('⚠️ تعذر جلب التمارين من Supabase: ' + error.message);
            return res.status(500).json({ 
                success: false, 
                error: error.message, 
                code: error.code, 
                details: error.details,
                hint: 'تعذر جلب التمارين من قاعدة البيانات. تأكد من إنشاء جدول exercise_posts في Supabase.' 
            });
        }

        let exercises = Array.isArray(rawExercises) ? rawExercises : [];

        // جلب معلومات الأساتذة المقترنين بالتمارين
        const teacherIds = [...new Set(exercises.map(e => e.teacher_id).filter(Boolean))];
        let teachersMap = {};
        if (teacherIds.length > 0) {
            try {
                const { data: teachersData } = await supabase
                    .from('teachers')
                    .select('id, full_name, profile_image, profile_url, specialization')
                    .in('id', teacherIds);

                if (teachersData && Array.isArray(teachersData)) {
                    teachersData.forEach(t => {
                        teachersMap[t.id] = t;
                    });
                }
            } catch (tErr) {
                logger.warn('خطأ في جلب بيانات الأساتذة للتمارين: ' + tErr.message);
            }
        }

        // جلب قائمة التمارين المحفوظة للمستخدم الحالي لمعرفة الحالة is_saved
        let allUserBookmarks = new Set();
        if (currentUserId) {
            try {
                const { data: userBookmarks } = await supabase
                    .from('exercise_bookmarks')
                    .select('exercise_id')
                    .eq('user_id', currentUserId)
                    .eq('user_type', currentUserType);

                if (userBookmarks && Array.isArray(userBookmarks)) {
                    userBookmarks.forEach(b => allUserBookmarks.add(b.exercise_id));
                }
            } catch (bErr) {
                // تجاهل إذا لم ينشأ الجدول بعد
            }
        }

        // تصفية وحقن بيانات الأستاذ و is_saved
        let formatted = exercises.map(ex => {
            const teacher = teachersMap[ex.teacher_id] || {};
            let imagesList = [];
            if (Array.isArray(ex.images)) {
                imagesList = ex.images;
            } else if (typeof ex.images === 'string') {
                try { imagesList = JSON.parse(ex.images); } catch(e) { imagesList = []; }
            }
            
            if (Array.isArray(imagesList)) {
                imagesList = imagesList.filter(img => typeof img === 'string' && img.trim() !== '' && img !== '[object Object]');
            } else {
                imagesList = [];
            }

            return {
                ...ex,
                teacher_name: teacher.full_name || ex.teacher_name || 'أستاذ المادة',
                teacher_profile_image: teacher.profile_image || teacher.profile_url || '/images/default-avatar.svg',
                teacher_specialization: teacher.specialization || ex.subject_name || 'أستاذ المحتوى',
                images: imagesList,
                is_saved: allUserBookmarks.has(ex.id)
            };
        });

        // فلترة بالبحث والتصنيف والمستوى
        if (level && level !== 'all') {
            formatted = formatted.filter(ex => {
                const el = ex.education_level || '';
                if (level === 'primary_all') return el.startsWith('primary') || el.includes('pri');
                if (level === 'middle_all') return el.includes('am') || el === 'bem' || el === 'middle_all';
                if (level === 'secondary_all') return el.includes('as') || el === 'bac' || el === 'secondary_all';
                if (level === 'university') return el.includes('uni') || el === 'university' || el === 'master' || el === 'doctorat';
                return el === level;
            });
        }

        if (search) {
            const s = search.toLowerCase().trim();
            formatted = formatted.filter(ex => 
                (ex.title || '').toLowerCase().includes(s) ||
                (ex.description || '').toLowerCase().includes(s) ||
                (ex.subject_name || '').toLowerCase().includes(s) ||
                (ex.teacher_name || '').toLowerCase().includes(s)
            );
        }

        res.json(formatted);
    } catch (err) {
        logger.error('❌ خطأ في جلب التمارين والحلول:', err.message);
        res.status(500).json({ success: false, error: err.message, stack: err.stack });
    }
});

// ============================================================
// 1.5. عدد التمارين والحلول الجديدة غير المشاهدة (يجب أن يكون قبل /:id)
// ============================================================
router.get('/unread-count', optionalAuth, async (req, res) => {
    try {
        const { last_viewed } = req.query;

        let query = supabase
            .from('exercise_posts')
            .select('id', { count: 'exact', head: true });

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
        logger.error('Error getting unread exercises count:', error.message);
        res.json({ success: true, unread_count: 0 });
    }
});

// ============================================================
// 2. جلب تمارين محدد بواسطة الـ ID (للمشاركة والزوار)
// ============================================================
router.get('/:id', optionalAuth, async (req, res) => {
    try {
        const exerciseId = parseInt(req.params.id);
        if (!exerciseId) {
            return res.status(400).json({ error: 'رقم التمرين غير صحيح' });
        }

        const exercise = await getOne('exercise_posts', 'id', exerciseId);
        if (!exercise) {
            return res.status(404).json({ error: 'منشور التمارين والحلول غير موجود' });
        }

        // زيادة عداد المشاهدات
        try {
            await supabase
                .from('exercise_posts')
                .update({ views_count: (exercise.views_count || 0) + 1 })
                .eq('id', exerciseId);
        } catch (vErr) {}

        // جلب بيانات الأستاذ
        let teacherData = {};
        if (exercise.teacher_id) {
            teacherData = await getOne('teachers', 'id', exercise.teacher_id) || {};
        }

        // تحقق من المحفوظات
        let isSaved = false;
        if (req.user) {
            try {
                const { data: bookmark } = await supabase
                    .from('exercise_bookmarks')
                    .select('id')
                    .eq('user_id', req.user.userId || req.user.id)
                    .eq('user_type', req.user.role)
                    .eq('exercise_id', exerciseId)
                    .single();
                if (bookmark) isSaved = true;
            } catch(bErr) {}
        }

        let imagesList = [];
        if (Array.isArray(exercise.images)) {
            imagesList = exercise.images;
        } else if (typeof exercise.images === 'string') {
            try { imagesList = JSON.parse(exercise.images); } catch(e) { imagesList = []; }
        }

        if (Array.isArray(imagesList)) {
            imagesList = imagesList.filter(img => typeof img === 'string' && img.trim() !== '' && img !== '[object Object]');
        } else {
            imagesList = [];
        }

        res.json({
            ...exercise,
            teacher_name: teacherData.full_name || 'أستاذ المادة',
            teacher_profile_image: teacherData.profile_image || teacherData.profile_url || '/images/default-avatar.svg',
            teacher_specialization: teacherData.specialization || 'أستاذ المحتوى',
            images: imagesList,
            is_saved: isSaved
        });
    } catch (err) {
        logger.error('❌ خطأ في جلب تفاصيل التمرين:', err.message);
        res.status(500).json({ error: 'حدث خطأ أثناء جلب تفاصيل التمرين' });
    }
});

// ============================================================
// 3. إضافة منشور تمارين وحلول جديد (للأساتذة فقط - حتى 10 صور)
// ============================================================
router.post('/', authenticate, [
    body('title').notEmpty().withMessage('عنوان التمارين والحلول مطلوب'),
    body('education_level').notEmpty().withMessage('المستوى الدراسي مطلوب')
], async (req, res) => {
    try {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'عذراً، يقتصر إضافة التمارين والحلول على الأساتذة فقط' });
        }

        const teacherId = req.user.userId || req.user.id;
        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher || teacher.status !== 'approved') {
            return res.status(403).json({ error: 'حسابك غير معتمد بعد، لا يمكنك إضافة تمارين حتى يتم قبول حسابك من قبل الإدارة' });
        }

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array().map(e => e.msg).join('، ') });
        }

        const { title, description, education_level, subject_name, images, external_link, classification } = req.body;

        // التأكد من أن الصور مصفوفة ولا تتجاوز 10 صور
        let imagesArray = [];
        if (Array.isArray(images)) {
            imagesArray = images.slice(0, 10);
        } else if (typeof images === 'string') {
            imagesArray = [images];
        }

        const newExerciseData = {
            teacher_id: req.user.userId || req.user.id,
            title: title.trim(),
            description: (description || '').trim(),
            education_level: education_level.trim(),
            subject_name: (subject_name || '').trim() || 'عام',
            images: JSON.stringify(imagesArray),
            external_link: (external_link || '').trim() || null,
            likes_count: 0,
            views_count: 0,
            shares_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            classification: (classification || 'تمرين').trim()
        };

        let created;
        try {
            created = await insert('exercise_posts', newExerciseData);
        } catch (insertErr) {
            if (insertErr.message && (insertErr.message.includes('classification') || insertErr.message.includes('column'))) {
                // Fallback if column does not exist yet on database
                const fallbackData = { ...newExerciseData };
                delete fallbackData.classification;
                created = await insert('exercise_posts', fallbackData);
            } else {
                throw insertErr;
            }
        }

        res.json({
            success: true,
            message: '🎉 تم نشر التمارين والحلول بنجاح!',
            exercise: created
        });
    } catch (err) {
        logger.error('❌ خطأ في إضافة التمارين والحلول:', err.message);
        res.status(500).json({ error: 'حدث خطأ أثناء حفظ منشور التمارين والحلول' });
    }
});

// ============================================================
// 3.5. تعديل منشور تمارين وحلول موجود (للأساتذة فقط)
// ============================================================
router.put('/:id', authenticate, [
    body('title').notEmpty().withMessage('عنوان التمارين والحلول مطلوب'),
    body('education_level').notEmpty().withMessage('المستوى الدراسي مطلوب')
], async (req, res) => {
    try {
        const exerciseId = parseInt(req.params.id);
        const currentUserId = req.user.userId || req.user.id;

        // Fetch existing exercise
        const existingExercise = await getOne('exercise_posts', 'id', exerciseId);
        if (!existingExercise) {
            return res.status(404).json({ error: 'عذراً، لم يتم العثور على منشور التمارين والحلول هذا' });
        }

        // Authorize: Only the owner (teacher_id matches currentUserId) or admin can edit
        if (req.user.role !== 'admin' && parseInt(existingExercise.teacher_id) !== parseInt(currentUserId)) {
            return res.status(403).json({ error: 'عذراً، لا تملك الصلاحية لتعديل هذا المنشور' });
        }

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array().map(e => e.msg).join('، ') });
        }

        const { title, description, education_level, subject_name, images, external_link, classification } = req.body;

        // Process images array if provided
        let imagesArray = [];
        if (Array.isArray(images)) {
            imagesArray = images.slice(0, 10);
        } else if (typeof images === 'string') {
            imagesArray = [images];
        } else if (existingExercise.images) {
            try {
                imagesArray = JSON.parse(existingExercise.images);
            } catch (e) {
                imagesArray = [];
            }
        }

        let externalLink = external_link;
        if (externalLink && !externalLink.startsWith('http://') && !externalLink.startsWith('https://')) {
            externalLink = 'https://' + externalLink;
        }

        const updatedData = {
            title: title.trim(),
            description: (description || '').trim(),
            education_level: education_level.trim(),
            subject_name: (subject_name || '').trim() || 'عام',
            images: JSON.stringify(imagesArray),
            external_link: (externalLink || '').trim() || null,
            updated_at: new Date().toISOString(),
            classification: (classification || 'تمرين').trim()
        };

        let updated;
        try {
            updated = await update('exercise_posts', exerciseId, updatedData);
        } catch (updateErr) {
            if (updateErr.message && (updateErr.message.includes('classification') || updateErr.message.includes('column'))) {
                // Fallback if column does not exist yet on database
                const fallbackData = { ...updatedData };
                delete fallbackData.classification;
                updated = await update('exercise_posts', exerciseId, fallbackData);
            } else {
                throw updateErr;
            }
        }

        res.json({
            success: true,
            message: '🎉 تم تعديل التمارين والحلول بنجاح!',
            exercise: updated
        });
    } catch (err) {
        logger.error('❌ خطأ في تعديل التمارين والحلول:', err.message);
        res.status(500).json({ error: 'حدث خطأ أثناء تعديل منشور التمارين والحلول' });
    }
});

// ============================================================
// 4. حفظ / إلغاء حفظ منشور تمارين في المحفوظات (حفظ المنشور)
// ============================================================
router.post('/:id/bookmark', authenticate, async (req, res) => {
    try {
        const exerciseId = parseInt(req.params.id);
        const userId = req.user.userId || req.user.id;
        const userType = req.user.role;

        if (!exerciseId) {
            return res.status(400).json({ error: 'رقم التمرين غير صحيح' });
        }

        // التحقق مما إذا كان موجوداً مسبقاً في المحفوظات
        let existingBookmark = null;
        try {
            const { data } = await supabase
                .from('exercise_bookmarks')
                .select('*')
                .eq('user_id', userId)
                .eq('user_type', userType)
                .eq('exercise_id', exerciseId)
                .single();
            existingBookmark = data;
        } catch(e) {}

        if (existingBookmark) {
            // إزالة من المحفوظات
            await supabase
                .from('exercise_bookmarks')
                .delete()
                .eq('id', existingBookmark.id);

            return res.json({
                success: true,
                is_saved: false,
                message: 'تم إزالة منشور التمارين والحلول من المحفوظات'
            });
        } else {
            // إضافة للمحفوظات
            await insert('exercise_bookmarks', {
                user_id: userId,
                user_type: userType,
                exercise_id: exerciseId,
                created_at: new Date().toISOString()
            });

            return res.json({
                success: true,
                is_saved: true,
                message: '🔖 تم حفظ منشور التمارين والحلول في المحفوظات بنجاح!'
            });
        }
    } catch (err) {
        logger.error('❌ خطأ في حفظ/إلغاء حفظ التمارين:', err.message);
        res.status(500).json({ error: 'حدث خطأ أثناء تحديث المحفوظات' });
    }
});

// ============================================================
// 4.5. زيادة عداد المشاهدات للمنشور
// ============================================================
router.post('/:id/view', async (req, res) => {
    try {
        const exerciseId = parseInt(req.params.id);
        if (!exerciseId) return res.status(400).json({ error: 'رقم التمرين غير صحيح' });

        const exercise = await getOne('exercise_posts', 'id', exerciseId);
        if (exercise) {
            await supabase
                .from('exercise_posts')
                .update({ views_count: (exercise.views_count || 0) + 1 })
                .eq('id', exerciseId);
        }
        res.json({ success: true });
    } catch (err) {
        logger.error('❌ خطأ في زيادة عداد المشاهدات:', err.message);
        res.json({ success: false });
    }
});

// ============================================================
// 5. زيادة عداد المشاركة للمنشور
// ============================================================
router.post('/:id/share', async (req, res) => {
    try {
        const exerciseId = parseInt(req.params.id);
        const exercise = await getOne('exercise_posts', 'id', exerciseId);
        if (exercise) {
            await supabase
                .from('exercise_posts')
                .update({ shares_count: (exercise.shares_count || 0) + 1 })
                .eq('id', exerciseId);
        }
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

// ============================================================
// 6. حذف منشور تمارين (للأستاذ صاحب المنشور أو الأدمن)
// ============================================================
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const exerciseId = parseInt(req.params.id);
        const exercise = await getOne('exercise_posts', 'id', exerciseId);

        if (!exercise) {
            return res.status(404).json({ error: 'المنشور غير موجود' });
        }

        if (req.user.role !== 'admin' && (req.user.role !== 'teacher' || parseInt(exercise.teacher_id) !== parseInt(req.user.userId || req.user.id))) {
            return res.status(403).json({ error: 'غير مصرح لك بحذف هذا المنشور' });
        }

        await remove('exercise_posts', 'id', exerciseId);
        
        try {
            await supabase.from('exercise_bookmarks').delete().eq('exercise_id', exerciseId);
        } catch(e) {}

        res.json({ success: true, message: 'تم حذف منشور التمارين والحلول بنجاح' });
    } catch (err) {
        logger.error('❌ خطأ في حذف منشور التمارين:', err.message);
        res.status(500).json({ error: 'حدث خطأ أثناء الحذف' });
    }
});

// ============================================================
// 7. عدد التمارين والحلول الجديدة غير المشاهدة
// ============================================================
router.get('/unread-count', optionalAuth, async (req, res) => {
    try {
        const { last_viewed } = req.query;

        let query = supabase
            .from('exercise_posts')
            .select('id', { count: 'exact', head: true });

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
        logger.error('Error getting unread exercises count:', error.message);
        res.json({ success: true, unread_count: 0 });
    }
});

module.exports = router;
