const logger = require('../utils/logger');
// ============================================================
// مسارات المنشورات - Post Routes (معدل بالكامل)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');

const { supabase } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { verifyToken } = require('../utils/jwt');
const { getOne, insert, update, remove, loadLocalTeacherFollowers, saveLocalTeacherFollowers } = require('../utils/helpers');
const { getPublicImageUrl, processUserProfile, uploadToSupabase } = require('../utils/upload');
const { recordUniqueView, getViewCount } = require('../utils/viewsTracker');
const multer = require('multer');
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // لا يمكن لأي ملف منفرد تجاوز 50 ميجابايت
});

// ============================================================
// نظام تتبع المشاهدات لكل IP فريد كل 24 ساعة
// ============================================================
const postIpViewsMap = new Map();

setInterval(() => {
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    for (const [key, timestamp] of postIpViewsMap.entries()) {
        if (now - timestamp > TWENTY_FOUR_HOURS) {
            postIpViewsMap.delete(key);
        }
    }
}, 3600000); // تنظيف الذاكرة كل ساعة

async function registerPostViewByIp(postId, reqIp, userRole, userId) {
    if (!postId) return null;
    const post = await getOne('posts', 'id', postId);
    if (!post) return null;

    // إذا كان مشاهد المنشور هو نفس الأستاذ صاحب المنشور، فلا نحسب المشاهدة
    if (userRole === 'teacher' && userId && parseInt(post.teacher_id) === parseInt(userId)) {
        return { counted: false, views: post.views_count || post.views || 0 };
    }

    const ip = reqIp || '127.0.0.1';
    const key = `${postId}_${ip}`;
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const lastView = postIpViewsMap.get(key);

    let currentViews = post.views_count || post.views || 0;

    if (lastView && (now - lastView < TWENTY_FOUR_HOURS)) {
        return { counted: false, views: currentViews };
    }

    // تسجيل المشاهدة وزيادة العداد
    postIpViewsMap.set(key, now);
    const newViews = currentViews + 1;

    try {
        const updateData = {};
        if (post.views_count !== undefined) {
            updateData.views_count = newViews;
        } else if (post.views !== undefined) {
            updateData.views = newViews;
        } else {
            updateData.views_count = newViews;
        }
        await update('posts', postId, updateData);
    } catch (err) {
        logger.warn('⚠️ تعذر تحديث عدد المشاهدات في قاعدة البيانات:', err.message);
    }

    return { counted: true, views: newViews };
}

// ============================================================
// 1. إنشاء منشور جديد (للأستاذ فقط - كتابة + رابط + صور)
// ============================================================
router.post('/create', authenticate, authorize(['teacher']), upload.array('files', 10), [
    body('content').notEmpty().withMessage('محتوى المنشور مطلوب').isLength({ max: 5000 }),
    body('link_url').optional({ nullable: true, checkFalsy: true }).isLength({ max: 1000 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = req.user.userId;
        const { content, link_url, title } = req.body;
        const files = req.files || [];
        
        // التحقق من إجمالي حجم الملفات (50 ميجابايت)
        const totalSize = files.reduce((acc, file) => acc + file.size, 0);
        
        if (totalSize > 50 * 1024 * 1024) {
            return res.status(400).json({ success: false, error: 'عذراً، إجمالي حجم الملفات المرفقة يتجاوز الحد المسموح به (50 ميجابايت)' });
        }

        const imageUrls = [];

        for (const file of files) {
            const uploadResult = await uploadToSupabase(file, 'posts');
            if (uploadResult && uploadResult.url) {
                imageUrls.push(uploadResult.url);
            }
        }

        // التحقق من وجود الأستاذ وحالته
        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        if (teacher.status !== 'approved') {
            return res.status(403).json({ 
                success: false, 
                error: 'عذراً، حسابك قيد المراجعة والانتظار. لا يمكنك إضافة منشورات حتى يتم قبول حسابك من قبل الإدارة.' 
            });
        }

        const postTitle = title ? title.trim() : (content.trim().substring(0, 60) + (content.length > 60 ? '...' : ''));

        const newPost = await insert('posts', {
            teacher_id,
            title: postTitle,
            content: content.trim(),
            link_url: link_url?.trim() || null,
            image_url: JSON.stringify(imageUrls),
            likes: 0,
            comments_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        // إرسال إشعارات للمتابعين والطلاب المحجوزين
        try {
            const notificationList = [];
            const addedKeys = new Set();

            // 1. جلب جميع المتابعين (طلاب وأساتذة)
            let allFollowers = [];
            const { data: followers } = await supabase
                .from('teacher_followers')
                .select('follower_id, follower_type')
                .eq('teacher_id', teacher_id);

            if (followers) {
                allFollowers = [...followers];
            }
            
            try {
                const localList = await loadLocalTeacherFollowers();
                localList.forEach(f => {
                    if (parseInt(f.teacher_id) === parseInt(teacher_id)) {
                        allFollowers.push({
                            follower_id: parseInt(f.follower_id),
                            follower_type: f.follower_type
                        });
                    }
                });
            } catch (localErr) {}

            if (allFollowers.length > 0) {
                for (const f of allFollowers) {
                    const key = `${f.follower_type}_${f.follower_id}`;
                    if (!addedKeys.has(key)) {
                        addedKeys.add(key);
                        notificationList.push({
                            user_id: f.follower_id,
                            user_type: f.follower_type,
                            title: `📝 منشور جديد من الأستاذ ${teacher.full_name || 'غير معروف'}`,
                            message: `${postTitle} [POST:${newPost.id}]`,
                            offer_id: null,
                            is_read: false,
                            created_at: new Date().toISOString()
                        });
                    }
                }
            }

            // 2. جلب الطلاب المشتركين في جلسات الأستاذ
            const { data: students } = await supabase
                .from('sessions')
                .select('student_id')
                .eq('teacher_id', teacher_id)
                .limit(100);

            if (students && students.length > 0) {
                for (const s of students) {
                    const key = `student_${s.student_id}`;
                    if (!addedKeys.has(key)) {
                        addedKeys.add(key);
                        notificationList.push({
                            user_id: s.student_id,
                            user_type: 'student',
                            title: `📝 منشور جديد من الأستاذ ${teacher.full_name || 'غير معروف'}`,
                            message: `${postTitle} [POST:${newPost.id}]`,
                            offer_id: null,
                            is_read: false,
                            created_at: new Date().toISOString()
                        });
                    }
                }
            }

            if (notificationList.length > 0) {
                await supabase.from('notifications').insert(notificationList);
            }
        } catch (notifErr) {
            logger.error('⚠️ خطأ في إرسال إشعارات المنشور:', notifErr.message);
        }

        res.json({
            success: true,
            message: 'تم نشر المنشور بنجاح',
            post: newPost
        });
    } catch (error) {
        logger.error('❌ خطأ في إنشاء المنشور:', error.message);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ في الخادم' });
    }
});
// ============================================================
// 2. جلب جميع المنشورات (للجميع: أساتذة وطلاب)
// ============================================================
router.get('/', async (req, res) => {
    try {
        let userId = null;
        let userType = null;

        // استخراج معرف المستخدم اختياري من توكن الترويسة إن وجد
        try {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.split(' ')[1];
                const decoded = verifyToken(token);
                if (decoded) {
                    userId = decoded.userId;
                    userType = decoded.role;
                }
            }
        } catch (authErr) {
            // توكن غير متوفر أو غير صالحة - يستمر الجلب عاماً
        }

        const { limit = 10, offset = 0, teacher_id, post_id, include_post_id, saved_only } = req.query;
        const parsedLimit = parseInt(limit) || 10;
        const parsedOffset = parseInt(offset) || 0;

        let query = supabase
            .from('posts')
            .select('*')
            .order('created_at', { ascending: false });

        if (post_id) {
            query = query.eq('id', parseInt(post_id));
        } else if (teacher_id) {
            query = query.eq('teacher_id', teacher_id);
        }

        if ((saved_only === 'true' || saved_only === true) && userId && userType) {
            try {
                const { data: userBookmarks } = await supabase
                    .from('post_bookmarks')
                    .select('post_id')
                    .eq('user_id', userId)
                    .eq('user_type', userType);
                const savedIds = (userBookmarks || []).map(b => b.post_id);
                if (savedIds.length === 0) {
                    return res.json({ posts: [], has_more: false, total: 0 });
                }
                query = query.in('id', savedIds);
            } catch (bmErr) {
                return res.json({ posts: [], has_more: false, total: 0 });
            }
        }

        query = query.range(parsedOffset, parsedOffset + parsedLimit - 1);

        const { data: posts, error } = await query;

        if (error) {
            logger.error('⚠️ خطأ استعلام المنشورات من Supabase:', error.message);
        }

        let rawPosts = posts || [];

        // التأكد من تضمين المنشور المشترك في حال لم يكن ضمن أول صفحة
        const targetPostId = parseInt(include_post_id || post_id);
        if (targetPostId && !isNaN(targetPostId) && !rawPosts.some(p => p.id === targetPostId)) {
            try {
                const { data: singlePost } = await supabase
                    .from('posts')
                    .select('*')
                    .eq('id', targetPostId)
                    .single();
                if (singlePost) {
                    rawPosts.unshift(singlePost);
                }
            } catch (spErr) {
                console.warn('⚠️ فشل جلب المنشور المشترك المنفرد:', spErr.message);
            }
        }

        // جلب بيانات الأساتذة يدوياً لتفادي مشاكل العلاقات غير المعرفة في قاعدة البيانات
        const teacherIds = [...new Set(rawPosts.map(p => p.teacher_id).filter(id => id))];
        const teachersMap = {};
        if (teacherIds.length > 0) {
            try {
                const { data: teachersData } = await supabase
                    .from('teachers')
                    .select('id, full_name, specialization, profile_image, profile_url, bio')
                    .in('id', teacherIds);
                
                if (teachersData) {
                    teachersData.forEach(t => {
                        teachersMap[t.id] = t;
                    });
                }
            } catch (tErr) {
                console.warn('⚠️ فشل جلب بيانات الأساتذة للمنشورات:', tErr.message);
            }
        }

        // جلب الإعجابات والمتابعات والمحفوظات الخاصة بالزائر الحالي دفعة واحدة لتفادي استعلامات متعددة
        const userLikedPostIds = new Set();
        const userSavedPostIds = new Set();
        const followedTeacherIds = new Set();

        if (userId && userType) {
            try {
                const postIds = rawPosts.map(p => p.id);
                if (postIds.length > 0) {
                    let lkQuery = supabase
                        .from('post_likes')
                        .select('post_id')
                        .in('post_id', postIds);

                    if (userType === 'student') {
                        lkQuery = lkQuery.or(`student_id.eq.${userId},user_id.eq.${userId}`);
                    } else if (userType === 'teacher') {
                        lkQuery = lkQuery.or(`teacher_id.eq.${userId},user_id.eq.${userId}`);
                    } else {
                        lkQuery = lkQuery.eq('user_id', userId);
                    }

                    const { data: userLikes } = await lkQuery;
                    if (userLikes) {
                        userLikes.forEach(l => userLikedPostIds.add(l.post_id));
                    }
                }
            } catch (lkErr) {
                console.warn('⚠️ فشل جلب تفضيلات الإعجاب للزائر:', lkErr.message);
            }

            try {
                const { data: userBookmarks } = await supabase
                    .from('post_bookmarks')
                    .select('post_id')
                    .eq('user_id', userId)
                    .eq('user_type', userType);
                if (userBookmarks && Array.isArray(userBookmarks)) {
                    userBookmarks.forEach(b => userSavedPostIds.add(b.post_id));
                }
            } catch (bmErr) {
                // تجاهل أخطاء جدول المحفوظات في حال لم يُنشأ بعد
            }

            try {
                if (teacherIds.length > 0) {
                    const { data: userFollows } = await supabase
                        .from('teacher_followers')
                        .select('teacher_id')
                        .in('teacher_id', teacherIds)
                        .eq('follower_id', userId)
                        .eq('follower_type', userType);

                    if (userFollows) {
                        userFollows.forEach(f => followedTeacherIds.add(f.teacher_id));
                    }

                    // دمج المتابعين المحليين
                    try {
                        const localList = await loadLocalTeacherFollowers();
                        localList.forEach(f => {
                            if (parseInt(f.follower_id) === parseInt(userId) && f.follower_type === userType) {
                                followedTeacherIds.add(parseInt(f.teacher_id));
                            }
                        });
                    } catch (lErr) {}
                }
            } catch (flwErr) {
                console.warn('⚠️ فشل جلب تفضيلات المتابعة للزائر:', flwErr.message);
            }
        }

        // تصفية المنشورات المحفوظة فقط في حال تم طلب خيار saved_only=true
        if (saved_only === 'true' || saved_only === true) {
            rawPosts = rawPosts.filter(p => userSavedPostIds.has(p.id));
        }

        // إثراء المنشورات بعدد الإعجابات، التعليقات، المتابعة، وهل أعجب أو حفظ به المستخدم
        const enrichedPosts = await Promise.all(rawPosts.map(async (post) => {
            post.teachers = teachersMap[post.teacher_id] || null;

            let likesCount = post.likes || 0;
            try {
                const { count } = await supabase
                    .from('post_likes')
                    .select('*', { count: 'exact', head: true })
                    .eq('post_id', post.id);
                if (typeof count === 'number') likesCount = count;
            } catch (e) {
                // تجاهل أخطاء عدد الإعجابات
            }

            let commentsCount = post.comments_count || 0;
            try {
                const { count } = await supabase
                    .from('post_comments')
                    .select('*', { count: 'exact', head: true })
                    .eq('post_id', post.id);
                if (typeof count === 'number') commentsCount = count;
            } catch (e) {
                // تجاهل أخطاء عدد التعليقات
            }

            const userLiked = userLikedPostIds.has(post.id);
            const isSaved = userSavedPostIds.has(post.id);
            const isFollowing = followedTeacherIds.has(post.teacher_id);

            // تجهيز صورة الأستاذ بدقة
            let teacherImg = '/images/default-avatar.svg';
            if (post.teachers) {
                const rawImg = post.teachers.profile_url || post.teachers.profile_image;
                if (rawImg && rawImg !== 'null' && rawImg !== 'undefined' && rawImg !== 'NULL') {
                    if (rawImg.startsWith('http://') || rawImg.startsWith('https://') || rawImg.startsWith('data:') || rawImg.startsWith('/')) {
                        teacherImg = rawImg;
                    } else {
                        teacherImg = getPublicImageUrl('profiles', 'teachers', rawImg) || rawImg;
                    }
                }
            }

            const postViews = getViewCount('post', post.id, post.views_count || post.views || 0);

            return {
                ...post,
                teacher_name: post.teachers?.full_name || 'أستاذ',
                teacher_specialization: post.teachers?.specialization || 'مدرس',
                teacher_profile_image: teacherImg,
                likes_count: likesCount || 0,
                comments_count: commentsCount || 0,
                views_count: postViews,
                views: postViews,
                user_liked: userLiked,
                is_saved: isSaved,
                user_saved: isSaved,
                is_following: isFollowing
            };
        }));

        res.json({ 
            success: true, 
            posts: enrichedPosts, 
            has_more: rawPosts.length >= parsedLimit, 
            offset: parsedOffset, 
            limit: parsedLimit 
        });
    } catch (error) {
        logger.error('❌ خطأ غير متوقع في جلب المنشورات:', error.message);
        res.status(200).json({ success: true, posts: [], error: error.message });
    }
});

// ============================================================
// 2.1 جلب منشور فردي حسب المعرف
// ============================================================
router.get('/:id', async (req, res) => {
    try {
        const postId = parseInt(req.params.id);
        if (!postId || isNaN(postId)) {
            return res.status(400).json({ success: false, error: 'معرف المنشور غير صالح' });
        }

        const { data: post, error } = await supabase
            .from('posts')
            .select('*')
            .eq('id', postId)
            .single();

        if (error || !post) {
            return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
        }

        let teacherData = null;
        if (post.teacher_id) {
            const { data: teacher } = await supabase
                .from('teachers')
                .select('id, full_name, specialization, profile_image, profile_url, bio')
                .eq('id', post.teacher_id)
                .single();
            teacherData = teacher;
        }

        const { count: likesCount } = await supabase
            .from('post_likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', postId);

        const { count: commentsCount } = await supabase
            .from('post_comments')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', postId);

        const views = getViewCount('post', post.id, post.views_count || post.views || 0);

        const enrichedPost = {
            ...post,
            teacher_name: teacherData?.full_name || 'أستاذ',
            teacher_specialization: teacherData?.specialization || '',
            teacher_profile_image: teacherData?.profile_url || getPublicImageUrl('profiles', 'teachers', teacherData?.profile_image) || null,
            likes_count: likesCount || 0,
            comments_count: commentsCount || 0,
            views_count: views,
            views: views,
            user_liked: false,
            is_following: false
        };

        res.json({ success: true, post: enrichedPost });
    } catch (error) {
        logger.error('❌ خطأ في جلب المنشور الفردي:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 2.2 تسجيل مشاهدة فريدة لمنشور حسب الـ IP كل 24 ساعة
// ============================================================
router.post('/:id/view', async (req, res) => {
    try {
        const postId = parseInt(req.params.id);
        if (!postId || isNaN(postId)) {
            return res.status(400).json({ success: false, error: 'معرف المنشور غير صالح' });
        }

        const result = await recordUniqueView('posts', 'id', postId, req, 'post');

        if (!result) {
            return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
        }

        res.json({ success: true, counted: result.counted, views: result.views });
    } catch (error) {
        logger.error('❌ خطأ في تسجيل مشاهدة المنشور:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 2.5 متابعة / إلغاء متابعة أستاذ (Toggle Follow)
// ============================================================
router.post('/toggle-follow', authenticate, [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = parseInt(req.body.teacher_id);
        const follower_id = parseInt(req.user.userId);
        const follower_type = req.user.role; // 'student' or 'teacher'

        if (follower_type === 'teacher' && follower_id === teacher_id) {
            return res.status(400).json({ success: false, error: 'لا يمكنك متابعة نفسك' });
        }

        const targetTeacher = await getOne('teachers', 'id', teacher_id);
        if (!targetTeacher && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        let isFollowing = false;

        // 1. التحديث في الملف المحلي الاحتياطي
        let localList = await loadLocalTeacherFollowers();
        const existingIdx = localList.findIndex(
            f => parseInt(f.teacher_id) === teacher_id && parseInt(f.follower_id) === follower_id && f.follower_type === follower_type
        );

        if (existingIdx !== -1) {
            localList.splice(existingIdx, 1);
            isFollowing = false;
        } else {
            localList.push({
                teacher_id,
                follower_id,
                follower_type,
                created_at: new Date().toISOString()
            });
            isFollowing = true;
        }
        await saveLocalTeacherFollowers(localList);

        // 2. محاولة المزامنة مع Supabase (بشكل آمن دون التسبب في خطأ يعطل العملية)
        try {
            const { data: existing, error: checkErr } = await supabase
                .from('teacher_followers')
                .select('id')
                .eq('teacher_id', teacher_id)
                .eq('follower_id', follower_id)
                .eq('follower_type', follower_type)
                .limit(1);

            if (!checkErr) {
                if (existing && existing.length > 0) {
                    await supabase
                        .from('teacher_followers')
                        .delete()
                        .eq('teacher_id', teacher_id)
                        .eq('follower_id', follower_id)
                        .eq('follower_type', follower_type);
                } else {
                    await supabase
                        .from('teacher_followers')
                        .insert({
                            teacher_id,
                            follower_id,
                            follower_type,
                            created_at: new Date().toISOString()
                        });
                }
            } else {
                logger.warn('Supabase check error in toggle-follow (falling back to local):', checkErr.message);
            }
        } catch (sbErr) {
            logger.error('Supabase exception in toggle-follow:', sbErr.message);
        }

        // 3. إرسال إشعار للأستاذ المتابَع
        if (isFollowing) {
            try {
                let followerName = 'مستخدم';
                if (follower_type === 'student') {
                    const st = await getOne('students', 'id', follower_id);
                    followerName = st?.full_name || st?.name || 'طالب';
                } else {
                    const tc = await getOne('teachers', 'id', follower_id);
                    followerName = tc?.full_name || 'أستاذ';
                }

                await supabase.from('notifications').insert({
                    user_id: teacher_id,
                    user_type: 'teacher',
                    title: '👤 متابع جديد',
                    message: `قام ${followerName} (${follower_type === 'teacher' ? 'أستاذ' : 'طالب'}) بمتابعتك الآن! [${follower_type.toUpperCase()}:${follower_id}]`,
                    is_read: false,
                    created_at: new Date().toISOString()
                });
            } catch (notifErr) {
                logger.error('Notification error on follow:', notifErr.message);
            }
        }

        res.json({
            success: true,
            is_following: isFollowing,
            message: isFollowing ? 'تمت المتابعة بنجاح' : 'تم إلغاء المتابعة'
        });
    } catch (error) {
        logger.error('❌ Error in toggle-follow:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء تنفيذ الطلب' });
    }
});

// ============================================================
// 2.6 عدد المنشورات غير المقروءة للأساتذة المُتَابَعين
// ============================================================
router.get('/unread-count', authenticate, async (req, res) => {
    try {
        const userId = req.user.userId;
        const userType = req.user.role;
        const { last_viewed } = req.query;

        const followedTeacherIdsSet = new Set();
        const { data: follows, error: followErr } = await supabase
            .from('teacher_followers')
            .select('teacher_id')
            .eq('follower_id', userId)
            .eq('follower_type', userType);

        if (!followErr && follows) {
            follows.forEach(f => followedTeacherIdsSet.add(f.teacher_id));
        }

        try {
            const localList = await loadLocalTeacherFollowers();
            localList.forEach(f => {
                if (parseInt(f.follower_id) === parseInt(userId) && f.follower_type === userType) {
                    followedTeacherIdsSet.add(parseInt(f.teacher_id));
                }
            });
        } catch (lErr) {}

        if (followedTeacherIdsSet.size === 0) {
            return res.json({ success: true, unread_count: 0 });
        }

        const followedTeacherIds = Array.from(followedTeacherIdsSet);

        let query = supabase
            .from('posts')
            .select('id', { count: 'exact', head: true })
            .in('teacher_id', followedTeacherIds);

        if (last_viewed && last_viewed !== 'null' && last_viewed !== 'undefined' && last_viewed !== '') {
            const parsedDate = new Date(last_viewed);
            if (!isNaN(parsedDate.getTime())) {
                query = query.gt('created_at', parsedDate.toISOString());
            } else {
                const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                query = query.gt('created_at', oneDayAgo);
            }
        } else {
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            query = query.gt('created_at', oneDayAgo);
        }

        const { count, error: countErr } = await query;
        if (countErr) {
            logger.error('Error getting unread posts count:', countErr.message);
            return res.json({ success: true, unread_count: 0 });
        }

        res.json({
            success: true,
            unread_count: count || 0
        });
    } catch (error) {
        logger.error('Error getting unread posts count:', error.message);
        res.json({ success: true, unread_count: 0 });
    }
});

// ============================================================
// 3. جلب تعليقات منشور معين (متاح للجميع والزوار)
// ============================================================
router.get('/comments/:post_id', async (req, res) => {
    try {
        const postId = parseInt(req.params.post_id);
        if (isNaN(postId)) {
            return res.status(400).json({ success: false, error: 'معرف المنشور غير صالح' });
        }

        const { data: rawComments, error } = await supabase
            .from('post_comments')
            .select('*')
            .eq('post_id', postId)
            .order('created_at', { ascending: true });

        if (error) {
            console.warn('⚠️ خطأ أو جدول التعليقات غير موجود:', error.message);
            return res.json({ success: true, comments: [] });
        }

        // تجديد بيانات أصحاب التعليقات
        const comments = await Promise.all((rawComments || []).map(async (c) => {
            let authorName = 'مستخدم';
            let authorImage = '/images/default-avatar.svg';
            let authorRole = c.user_type || (c.student_id ? 'student' : (c.teacher_id ? 'teacher' : 'student'));

            if (c.student_id || c.user_type === 'student') {
                const sId = c.student_id || c.user_id;
                if (sId) {
                    const student = await getOne('students', 'id', sId);
                    if (student) {
                        authorName = student.full_name || student.name || 'طالب';
                        authorImage = student.profile_url || (student.profile_image ? getPublicImageUrl('profiles', 'students', student.profile_image) : null) || authorImage;
                        authorRole = 'student';
                    }
                }
            } else if (c.teacher_id || c.user_type === 'teacher') {
                const tId = c.teacher_id || c.user_id;
                if (tId) {
                    const teacher = await getOne('teachers', 'id', tId);
                    if (teacher) {
                        authorName = teacher.full_name || teacher.name || 'أستاذ';
                        authorImage = teacher.profile_url || (teacher.profile_image ? getPublicImageUrl('profiles', 'teachers', teacher.profile_image) : null) || authorImage;
                        authorRole = 'teacher';
                    }
                }
            }

            return {
                id: c.id,
                post_id: c.post_id,
                parent_id: c.parent_id || null,
                comment: c.comment || c.content || '',
                created_at: c.created_at || new Date().toISOString(),
                author_name: authorName,
                author_image: authorImage,
                author_role: authorRole,
                user_id: c.user_id || c.student_id || c.teacher_id,
                user_type: authorRole
            };
        }));

        res.json({ success: true, comments });
    } catch (error) {
        logger.error('❌ خطأ في جلب التعليقات:', error.message);
        res.status(500).json({ success: false, comments: [], error: error.message });
    }
});

// ============================================================
// 4. إعجاب / إلغاء الإعجاب بمنشور (للطلاب والأساتذة)
// ============================================================
router.post('/toggle-like', authenticate, authorize(['student', 'teacher']), [
    body('post_id').isInt().withMessage('معرف المنشور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, error: errors.array()[0]?.msg || 'بيانات غير صالحة', errors: errors.array() });
        }

        const postId = parseInt(req.body.post_id);
        const userId = req.user.userId;
        const userType = req.user.role;
        
        const post = await getOne('posts', 'id', postId);
        if (!post) {
            return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
        }

        // البحث عن إعجاب موجود
        let existing = null;
        if (userType === 'student') {
            const { data } = await supabase
                .from('post_likes')
                .select('id')
                .eq('post_id', postId)
                .or(`student_id.eq.${userId},and(user_id.eq.${userId},user_type.eq.student)`)
                .limit(1);
            if (data && data.length > 0) existing = data[0];
        } else {
            const { data } = await supabase
                .from('post_likes')
                .select('id')
                .eq('post_id', postId)
                .or(`teacher_id.eq.${userId},and(user_id.eq.${userId},user_type.eq.teacher)`)
                .limit(1);
            if (data && data.length > 0) existing = data[0];
        }

        let liked = false;
        if (existing) {
            // إلغاء الإعجاب
            await supabase.from('post_likes').delete().eq('id', existing.id);
            liked = false;
        } else {
            // إضافة الإعجاب
            const insertObj = {
                post_id: postId,
                user_id: userId,
                user_type: userType,
                created_at: new Date().toISOString()
            };
            if (userType === 'student') insertObj.student_id = userId;
            if (userType === 'teacher') insertObj.teacher_id = userId;

            try {
                await supabase.from('post_likes').insert(insertObj);
            } catch (likeErr) {
                // محاولة بدون student_id/teacher_id في حال عدم وجودها
                await supabase.from('post_likes').insert({
                    post_id: postId,
                    user_id: userId,
                    user_type: userType,
                    created_at: new Date().toISOString()
                });
            }
            liked = true;
            
            // إرسال إشعار لصاحب المنشور
            try {
                if (post.teacher_id && !(userType === 'teacher' && userId === post.teacher_id)) {
                    let likerName = userType === 'teacher' ? 'أستاذ' : 'طالب';
                    if (userType === 'student') {
                        const student = await getOne('students', 'id', userId);
                        if (student) likerName = student.full_name || student.name || 'طالب';
                    } else {
                        const teacher = await getOne('teachers', 'id', userId);
                        if (teacher) likerName = teacher.full_name || teacher.name || 'أستاذ';
                    }
                    
                    await supabase.from('notifications').insert({
                        user_id: post.teacher_id,
                        user_type: 'teacher',
                        title: `❤️ إعجاب جديد بمنشورك`,
                        message: `أعجب ${likerName} بمنشورك الأخير`,
                        offer_id: null,
                        is_read: false,
                        created_at: new Date().toISOString()
                    });
                }
            } catch (notifErr) {
                console.warn('⚠️ خطأ في إرسال إشعار الإعجاب:', notifErr.message);
            }
        }

        // تحديث إجمالي الإعجابات
        let likesCount = 0;
        try {
            const { count } = await supabase
                .from('post_likes')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', postId);
            likesCount = count || 0;
            await update('posts', postId, { likes: likesCount, updated_at: new Date().toISOString() });
        } catch (cntErr) {
            console.warn('⚠️ فشل تحديث إجمالي الإعجابات:', cntErr.message);
        }

        res.json({
            success: true,
            liked,
            likes_count: likesCount
        });
    } catch (error) {
        logger.error('❌ خطأ في الإعجاب/إلغاء الإعجاب:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 4.ب. حفظ / إلغاء حفظ منشور في المحفوظات (للطلاب والأساتذة)
// ============================================================
const handleTogglePostBookmark = async (req, res) => {
    try {
        const postId = parseInt(req.params.id || req.body.post_id || req.body.id);
        const userId = req.user.userId || req.user.id;
        const userType = req.user.role;

        if (!postId || isNaN(postId)) {
            return res.status(400).json({ success: false, error: 'رقم المنشور غير صحيح' });
        }

        // التحقق مما إذا كان المنشور موجوداً
        const post = await getOne('posts', 'id', postId);
        if (!post) {
            return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
        }

        // التحقق مما إذا كان المنشور محفوظاً مسبقاً
        let existingBookmark = null;
        try {
            const { data } = await supabase
                .from('post_bookmarks')
                .select('*')
                .eq('user_id', userId)
                .eq('user_type', userType)
                .eq('post_id', postId)
                .maybeSingle();
            existingBookmark = data;
        } catch (e) {}

        if (existingBookmark) {
            // إزالة من المحفوظات
            try {
                await supabase
                    .from('post_bookmarks')
                    .delete()
                    .eq('id', existingBookmark.id);
            } catch (e) {
                await supabase
                    .from('post_bookmarks')
                    .delete()
                    .eq('user_id', userId)
                    .eq('user_type', userType)
                    .eq('post_id', postId);
            }

            return res.json({
                success: true,
                is_saved: false,
                message: 'تم إزالة المنشور من المحفوظات'
            });
        } else {
            // إضافة للمحفوظات
            try {
                await insert('post_bookmarks', {
                    user_id: userId,
                    user_type: userType,
                    post_id: postId,
                    created_at: new Date().toISOString()
                });
            } catch (e) {
                await supabase.from('post_bookmarks').insert([{
                    user_id: userId,
                    user_type: userType,
                    post_id: postId,
                    created_at: new Date().toISOString()
                }]);
            }

            return res.json({
                success: true,
                is_saved: true,
                message: '🔖 تم حفظ المنشور في المحفوظات بنجاح!'
            });
        }
    } catch (error) {
        logger.error('❌ خطأ في حفظ المنشور:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء حفظ المنشور: ' + error.message });
    }
};

router.post('/:id/bookmark', authenticate, handleTogglePostBookmark);
router.post('/toggle-bookmark', authenticate, handleTogglePostBookmark);

// ============================================================
// 5. إضافة تعليق على منشور (للطلاب والأساتذة)
// ============================================================
router.post('/comment', authenticate, authorize(['student', 'teacher']), [
    body('post_id').notEmpty().withMessage('معرف المنشور مطلوب').isInt().withMessage('معرف المنشور غير صالح'),
    body('comment').notEmpty().withMessage('التعليق لا يمكن أن يكون فارغاً').isLength({ max: 2000 }).withMessage('التعليق طويل جداً'),
    body('parent_id').optional({ nullable: true, checkFalsy: true }).isInt().withMessage('معرف الرد غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                success: false, 
                error: errors.array()[0]?.msg || 'بيانات التعليق غير صالحة',
                errors: errors.array() 
            });
        }

        const postId = parseInt(req.body.post_id);
        const commentText = req.body.comment.trim();
        const parentId = (req.body.parent_id && !isNaN(parseInt(req.body.parent_id))) ? parseInt(req.body.parent_id) : null;
        const userId = req.user.userId;
        const userType = req.user.role;

        // ✅ منع المستخدم الزائر من التعليق
        if (!userId || userId === -1 || userId === '-1') {
            return res.status(403).json({ 
                success: false, 
                error: 'عذراً، يجب تسجيل الدخول أو إنشاء حساب لإضافة تعليق.' 
            });
        }

        // التحقق من وجود المنشور
        const post = await getOne('posts', 'id', postId);
        if (!post) {
            return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
        }

        // تجديد بيانات صاحب التعليق
        let authorName = userType === 'teacher' ? 'أستاذ' : 'طالب';
        let authorImage = '/images/default-avatar.svg';

        if (userType === 'student') {
            const student = await getOne('students', 'id', userId);
            if (student) {
                authorName = student.full_name || student.name || 'طالب';
                authorImage = student.profile_url || (student.profile_image ? getPublicImageUrl('profiles', 'students', student.profile_image) : null) || authorImage;
            }
        } else {
            const teacher = await getOne('teachers', 'id', userId);
            if (teacher) {
                authorName = teacher.full_name || teacher.name || 'أستاذ';
                authorImage = teacher.profile_url || (teacher.profile_image ? getPublicImageUrl('profiles', 'teachers', teacher.profile_image) : null) || authorImage;
            }
        }

        // تجهيز بيانات الإدخال
        const insertObj = {
            post_id: postId,
            user_id: userId,
            user_type: userType,
            comment: commentText,
            content: commentText,
            created_at: new Date().toISOString()
        };
        if (parentId) {
            insertObj.parent_id = parentId;
        }
        if (userType === 'student') insertObj.student_id = userId;
        if (userType === 'teacher') insertObj.teacher_id = userId;

        let newComment = null;
        let lastError = null;

        // 1. محاولة الإدخال الأولى
        try {
            newComment = await insert('post_comments', insertObj);
        } catch (err1) {
            lastError = err1;
            console.warn('⚠️ محاولة الإدخال الأولى في post_comments:', err1.message);
        }

        // 2. محاولة بديلة بدون حقل content (إذا كان الجدول يحتوي على comment فقط)
        if (!newComment) {
            try {
                const altObj1 = {
                    post_id: postId,
                    user_id: userId,
                    user_type: userType,
                    comment: commentText,
                    created_at: new Date().toISOString()
                };
                if (parentId) altObj1.parent_id = parentId;
                if (userType === 'student') altObj1.student_id = userId;
                if (userType === 'teacher') altObj1.teacher_id = userId;
                newComment = await insert('post_comments', altObj1);
            } catch (err2) {
                lastError = err2;
            }
        }

        // 3. محاولة بديلة بالأعمدة الأساسية فقط (post_id, user_id, user_type, comment)
        if (!newComment) {
            try {
                const altObj2 = {
                    post_id: postId,
                    user_id: userId,
                    user_type: userType,
                    comment: commentText,
                    created_at: new Date().toISOString()
                };
                if (parentId) altObj2.parent_id = parentId;
                newComment = await insert('post_comments', altObj2);
            } catch (err3) {
                lastError = err3;
            }
        }

        // 4. محاولة بديلة بحقل content بدلاً من comment
        if (!newComment) {
            try {
                const altObj3 = {
                    post_id: postId,
                    user_id: userId,
                    user_type: userType,
                    content: commentText,
                    created_at: new Date().toISOString()
                };
                if (parentId) altObj3.parent_id = parentId;
                newComment = await insert('post_comments', altObj3);
            } catch (err4) {
                lastError = err4;
            }
        }

        // 5. محاولة مباشرة عبر supabase client
        if (!newComment) {
            try {
                const directObj = {
                    post_id: postId,
                    user_id: userId,
                    user_type: userType,
                    comment: commentText,
                    created_at: new Date().toISOString()
                };
                if (parentId) directObj.parent_id = parentId;
                const { data: directData, error: directErr } = await supabase
                    .from('post_comments')
                    .insert(directObj)
                    .select();
                if (directErr) throw directErr;
                if (directData && directData.length > 0) {
                    newComment = directData[0];
                }
            } catch (err5) {
                lastError = err5;
            }
        }

        if (!newComment) {
            logger.error('❌ تعذر إدخال التعليق في post_comments:', lastError?.message);
            return res.status(500).json({ 
                success: false, 
                error: 'تعذر إضافة التعليق إلى قاعدة البيانات: ' + (lastError?.message || 'خطأ غير معروف')
            });
        }

        // تحديث عدد التعليقات
        let commentsCount = 0;
        try {
            const { count } = await supabase
                .from('post_comments')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', postId);
            commentsCount = count || 0;
            await update('posts', postId, { comments_count: commentsCount, updated_at: new Date().toISOString() });
        } catch (cntErr) {
            console.warn('⚠️ فشل تحديث comments_count في posts:', cntErr.message);
        }

        // إرسال إشعار لصاحب المنشور إذا كان المعلق شخصاً آخر
        try {
            if (post.teacher_id && !(userType === 'teacher' && userId === post.teacher_id)) {
                await supabase.from('notifications').insert({
                    user_id: post.teacher_id,
                    user_type: 'teacher',
                    title: `💬 تعليق جديد على منشورك`,
                    message: `${authorName}: ${commentText.substring(0, 50)}${commentText.length > 50 ? '...' : ''} [POST:${postId}]`,
                    offer_id: null,
                    is_read: false,
                    created_at: new Date().toISOString()
                });
            }
        } catch (notifErr) {
            console.warn('⚠️ خطأ في إرسال إشعار التعليق:', notifErr.message);
        }

        res.json({
            success: true,
            message: 'تمت إضافة التعليق بنجاح',
            comment: {
                id: newComment.id,
                post_id: postId,
                parent_id: parentId,
                comment: commentText,
                created_at: newComment.created_at || new Date().toISOString(),
                author_name: authorName,
                author_image: authorImage,
                author_role: userType,
                user_id: userId
            },
            comments_count: commentsCount
        });
    } catch (error) {
        logger.error('❌ خطأ في إضافة تعليق:', error.message);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ أثناء إضافة التعليق' });
    }
});

// ============================================================
// 6. حذف تعليق (لصاحب التعليق أو صاحب المنشور)
// ============================================================
router.delete('/comment/:comment_id', authenticate, async (req, res) => {
    try {
        const commentId = parseInt(req.params.comment_id);
        if (isNaN(commentId)) {
            return res.status(400).json({ success: false, error: 'معرف التعليق غير صالح' });
        }
        const userId = req.user.userId;
        const userType = req.user.role;

        const comment = await getOne('post_comments', 'id', commentId);
        if (!comment) {
            return res.status(404).json({ success: false, error: 'التعليق غير موجود' });
        }

        const post = await getOne('posts', 'id', comment.post_id);

        // الصلاحية: صاحب التعليق أو الأستاذ صاحب المنشور أو الإدارة
        const isCommentAuthor = (comment.user_id && comment.user_id === userId && comment.user_type === userType) ||
                                (userType === 'student' && comment.student_id === userId) ||
                                (userType === 'teacher' && comment.teacher_id === userId);
        const isPostOwner = (userType === 'teacher' && post && post.teacher_id === userId);
        const isAdmin = userType === 'admin';

        if (!isCommentAuthor && !isPostOwner && !isAdmin) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذا التعليق' });
        }

        // حذف الردود الفرعية إن وجدت
        try {
            await supabase.from('post_comments').delete().eq('parent_id', commentId);
        } catch (e) {
            console.warn('⚠️ فشل حذف الردود الفرعية:', e.message);
        }

        await remove('post_comments', 'id', commentId);

        // تحديث عدد التعليقات
        let commentsCount = 0;
        try {
            const { count } = await supabase
                .from('post_comments')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', comment.post_id);
            commentsCount = count || 0;
            if (post) {
                await update('posts', comment.post_id, { comments_count: commentsCount, updated_at: new Date().toISOString() });
            }
        } catch (cntErr) {
            console.warn('⚠️ تعذر تحديث عدد التعليقات بعد الحذف:', cntErr.message);
        }

        res.json({ success: true, message: 'تم حذف التعليق بنجاح', comments_count: commentsCount });
    } catch (error) {
        logger.error('❌ خطأ في حذف التعليق:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 7. حذف منشور (صاحب المنشور فقط)
// ============================================================
router.delete('/:post_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const postId = parseInt(req.params.post_id);
        const teacherId = req.user.userId;

        const post = await getOne('posts', 'id', postId);
        if (!post) {
            return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
        }

        if (post.teacher_id !== teacherId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذا المنشور' });
        }

        await supabase.from('post_likes').delete().eq('post_id', postId);
        await supabase.from('post_comments').delete().eq('post_id', postId);
        await remove('posts', 'id', postId);

        res.json({ success: true, message: 'تم حذف المنشور بجميع تعليقاته بنجاح' });
    } catch (error) {
        logger.error('❌ خطأ في حذف المنشور:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
