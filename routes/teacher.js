// ============================================================
// مسارات الأستاذ - Teacher Routes (مبسط - بدون الدوال الجديدة)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');

const { supabase } = require('../config/database');
const { ADMIN_EMAIL } = require('../utils/adminConfig');
const { authenticate, authorize, checkBanned } = require('../middleware/auth');
const { getOne, insert, update, remove, isNameTaken, loadLocalTeacherFollowers, saveLocalTeacherFollowers } = require('../utils/helpers');
const { uploadToSupabase, validateUploadedFiles, getPublicImageUrl, processUserProfile } = require('../utils/upload');
const { isValidDzPhone } = require('../utils/validation');
const { sendWithdrawalOtpEmail } = require('../utils/email');
const { getViewCount, syncItemViews } = require('../utils/viewsTracker');
const logger = require('../utils/logger');

// تخزين مؤقت لرموز التحقق لسحب الأرباح (In-Memory OTP Store)
const withdrawalOtpStore = new Map();

// تنظيف الرموز المنتهية تلقائياً كل 5 دقائق
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of withdrawalOtpStore.entries()) {
        if (now > value.expiresAt) {
            withdrawalOtpStore.delete(key);
        }
    }
}, 5 * 60 * 1000);

const ALLOWED_MIME_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain'
];
const ALLOWED_EXTENSIONS = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf',
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'
];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit

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
// جلب معلومات الأستاذ الحالي (يجب أن يكون قبل /:teacher_id)
// ============================================================
router.get('/me', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        let teacher = null;
        if (req.user.userId === -1 || req.user.userId === '-1') {
            return res.json({
                id: -1,
                full_name: 'أستاذ زائر',
                email: 'guest@zoomdz.com',
                is_guest: true,
                role: 'teacher',
                status: 'approved',
                profile_completion: true,
                balance: 0
            });
        }
        if (req.user.userId === 0 || req.user.email === ADMIN_EMAIL) {
            teacher = await getOne('teachers', 'email', ADMIN_EMAIL);
            if (!teacher) {
                teacher = {
                    id: 0,
                    full_name: 'مدير المنصة',
                    email: ADMIN_EMAIL,
                    status: 'approved',
                    rank: 'مدير',
                    subject: 'إدارة المنصة',
                    bio: 'حساب إدارة المنصة المباشر',
                    balance: 100000,
                    profile_completion: true,
                    email_verified: true
                };
            }
        } else {
            teacher = await getOne('teachers', 'id', req.user.userId);
        }

        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        if (teacher.email === ADMIN_EMAIL || req.user.email === ADMIN_EMAIL) {
            teacher.rank = 'مدير';
            teacher.status = 'approved';
            teacher.is_admin = true;
        }

        teacher.profile_image = teacher.profile_url || getPublicImageUrl('profiles', 'teachers', teacher.profile_image);
        delete teacher.password;

        // حساب عدد المتابعين
        let followersCount = 0;
        try {
            const { count } = await supabase
                .from('teacher_followers')
                .select('*', { count: 'exact', head: true })
                .eq('teacher_id', teacher.id);
            if (typeof count === 'number') followersCount = count;
        } catch (dbErr) {}

        try {
            const localList = await loadLocalTeacherFollowers();
            const localCount = localList.filter(f => parseInt(f.teacher_id) === parseInt(teacher.id)).length;
            if (localCount > followersCount) followersCount = localCount;
        } catch (lErr) {}

        teacher.followers_count = followersCount;
        teacher.requires_profile_completion = !teacher.profile_completion;

        res.json({
            success: true,
            teacher: teacher
        });
    } catch (error) {
        logger.error('خطأ في جلب بيانات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// حفظ مفتاح SofizPay العام للأستاذ
// ============================================================
router.post('/sofizpay-key', authenticate, authorize(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('sofizpay_public_key').isLength({ min: 30, max: 80 }).withMessage('مفتاح SofizPay العام غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, sofizpay_public_key } = req.body;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الحساب' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        await update('teachers', teacher_id, {
            sofizpay_public_key: sofizpay_public_key.trim()
        });

        res.json({
            success: true,
            message: 'تم حفظ مفتاح SofizPay بنجاح'
        });
    } catch (error) {
        logger.error('خطأ في حفظ مفتاح SofizPay:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب حالة إكمال الملف الشخصي (يجب أن يكون قبل المسار الديناميكي /:teacher_id)
// ============================================================
router.get('/profile-completion-status', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        if (req.user.userId === 0 || req.user.email === ADMIN_EMAIL || req.user.role === 'admin') {
            return res.json({
                success: true,
                profile_completion: true,
                status: 'approved',
                requires_profile_completion: false
            });
        }
        const teacher = await getOne('teachers', 'id', req.user.userId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        res.json({
            success: true,
            profile_completion: teacher.profile_completion || false,
            status: teacher.status || 'approved',
            requires_profile_completion: !teacher.profile_completion
        });
    } catch (error) {
        logger.error('خطأ في جلب حالة إكمال الملف الشخصي:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب بيانات الأستاذ
// ============================================================
router.get('/:teacher_id(\\d+)', authenticate, [
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        

        const teacher_id = parseInt(req.params.teacher_id);

        if (req.user.userId !== teacher_id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بدرس هذه المعلومات' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        }
        
        delete teacher.password;
        
        res.json(teacher);
    } catch (error) {
        logger.error('خطأ في جلب بيانات الأستاذ:', error.message);
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
            profile_image: uploaded.url,
            profile_url: uploaded.url
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
            user: data ? processUserProfile(data[0], 'teacher') : null 
        });
    } catch (error) {
        logger.error('خطأ في تحديث الصورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث الملف الشخصي وكافة المعلومات والروابط الاجتماعية
// ============================================================
router.post('/update-profile-with-social', authenticate, authorize(['teacher', 'admin']), upload.fields([
    { name: 'profile_image', maxCount: 1 }
]), validateUploadedFiles, [
    body('teacher_id').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = req.body.teacher_id ? parseInt(req.body.teacher_id) : req.user.userId;

        console.log('📝 تحديث الملف الشخصي للأستاذ:', teacher_id);

        if (req.user.userId !== teacher_id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        const oldTeacher = await getOne('teachers', 'id', teacher_id);
        if (!oldTeacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        const { 
            full_name,
            phone,
            specialization,
            subject,
            experience,
            teaching_level,
            bio,
            facebook_url, 
            instagram_url, 
            linkedin_url, 
            youtube_url, 
            twitter_url, 
            website_url, 
            whatsapp_number,
            ccp_account,
            sofizpay_public_key
        } = req.body;

        let profile_image = null;

        if (req.files && req.files['profile_image'] && req.files['profile_image'][0]) {
            const file = req.files['profile_image'][0];
            const uploaded = await uploadToSupabase(file, 'teachers', oldTeacher?.profile_image);
            if (uploaded) {
                profile_image = uploaded.url;
            }
        }

        const updateData = {};

        // تحديث المعلومات الأساسية والتعليمية
        if (full_name !== undefined && full_name !== null && full_name.trim() !== '') {
            const newName = full_name.trim();
            if (newName !== (oldTeacher.full_name || oldTeacher.name)) {
                const nameCheck = await isNameTaken(newName, teacher_id, 'teacher');
                if (nameCheck.taken) {
                    return res.status(400).json({
                        success: false,
                        error: '⚠️ هذا الاسم مستخدم مسبقاً في المنصة. يرجى اختيار اسم فريد.'
                    });
                }
            }
            updateData.full_name = newName;
        }

        if (phone !== undefined && phone !== null && phone.trim() !== '') {
            const cleanPhone = phone.trim();
            if (!isValidDzPhone(cleanPhone)) {
                return res.status(400).json({ 
                    success: false, 
                    error: '⚠️ رقم الهاتف يجب أن يكون برقم جزائري صحيح (مثال: 0550123456 أو 0660123456 أو 0770123456)' 
                });
            }
            updateData.phone = cleanPhone;
        }

        const specValue = specialization || subject;
        if (specValue !== undefined && specValue !== null && specValue.trim() !== '') {
            updateData.specialization = specValue.trim();
            updateData.subject = specValue.trim();
        }

        if (experience !== undefined && experience !== null && experience.trim() !== '') {
            updateData.experience = experience.trim();
        }

        if (teaching_level !== undefined && teaching_level !== null && teaching_level.trim() !== '') {
            updateData.teaching_level = teaching_level.trim();
        }

        if (bio !== undefined && bio !== null) {
            updateData.bio = bio.trim();
        }

        if (profile_image) { 
            updateData.profile_image = profile_image;
            updateData.profile_url = profile_image;
        }

        if (ccp_account !== undefined && ccp_account !== null) {
            updateData.ccp_account = ccp_account.trim() === '' ? null : ccp_account.trim();
        }

        if (sofizpay_public_key !== undefined && sofizpay_public_key !== null) {
            updateData.sofizpay_public_key = sofizpay_public_key.trim() === '' ? null : sofizpay_public_key.trim();
        }

        const socialFields = {
            facebook_url,
            instagram_url,
            linkedin_url,
            youtube_url,
            twitter_url,
            website_url
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

        if (whatsapp_number !== undefined && whatsapp_number !== null) {
            const normalizedWhatsapp = whatsapp_number.replace(/[\s()-]/g, '').replace(/^00/, '+');
            if (normalizedWhatsapp && !/^\+?[1-9]\d{7,14}$/.test(normalizedWhatsapp)) {
                return res.status(400).json({ success: false, error: 'رقم واتساب غير صالح. أدخل الرقم بصيغة دولية مثل 213550123456' });
            }
            updateData.whatsapp_number = normalizedWhatsapp || null;
        }

        updateData.updated_at = new Date().toISOString();

        console.log('💾 البيانات المراد تحديثها:', updateData);

        const { data, error } = await supabase
            .from('teachers')
            .update(updateData)
            .eq('id', teacher_id)
            .select();

        if (error) {
            logger.error('❌ خطأ في تحديث قاعدة البيانات:', error);
            throw error;
        }

        const updatedTeacher = data ? data[0] : null;

        console.log('✅ تم تحديث الملف الشخصي بنجاح');

        res.json({
            success: true,
            message: 'تم تحديث كافة معلومات الملف الشخصي بنجاح',
            user: updatedTeacher ? processUserProfile(updatedTeacher, 'teacher') : null
        });
    } catch (error) {
        logger.error('❌ خطأ في تحديث الملف الشخصي:', error.message);
        logger.error('📚 Stack:', error.stack);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ أثناء تحديث الملف الشخصي' });
    }
});

// ============================================================
// ✅ تحديث المستوى التعليمي فقط (للإدارة فقط)
// ============================================================
router.post('/update-teaching-level', authenticate, authorize(['admin']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ مطلوب'),
    body('teaching_level').notEmpty().withMessage('المستوى التعليمي مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, teaching_level } = req.body;

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        const { data, error } = await supabase
            .from('teachers')
            .update({ teaching_level: teaching_level.trim() })
            .eq('id', teacher_id)
            .select();

        if (error) throw error;

        res.json({
            success: true,
            message: 'تم تحديث المستوى التعليمي بنجاح',
            teaching_level: teaching_level,
            user: data ? data[0] : null
        });
    } catch (error) {
        logger.error('❌ خطأ في تحديث المستوى التعليمي:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب الأساتذة مع فلتر المستوى التعليمي
// ============================================================
router.get('/public/teachers', async (req, res) => {
    try {
        const { level } = req.query;
        
        let query = supabase
            .from('teachers')
            .select('*')
            .eq('status', 'approved')
            .order('created_at', { ascending: false });

        if (level && level !== 'all') {
            query = query.eq('teaching_level', level);
        }

        const { data: teachers, error } = await query;

        if (error) throw error;

        const sanitized = (teachers || []).map(t => {
            delete t.password;
            return t;
        });

        res.json(sanitized);
    } catch (error) {
        logger.error('خطأ في جلب الأساتذة:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب الملف الشخصي العام لأستاذ معين
// ============================================================
router.get('/public/teacher/:teacher_id', async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);
        
        
        // محاولة الحصول على المستخدم الحالي إذا كان مسجلاً للدخول
        let userId = null;
        let userType = null;
        try {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.split(' ')[1];
                const { verifyToken } = require('../utils/jwt');
                const decoded = verifyToken(token); // need to check how token is verified elsewhere
                if (decoded) {
                    userId = decoded.userId;
                    userType = decoded.role;
                }
            }
        } catch (authErr) {
            // تجاهل خطأ التوثيق إذا كان المستخدم غير مسجل
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }
        delete teacher.password;
        teacher.profile_image = teacher.profile_url || getPublicImageUrl('profiles', 'teachers', teacher.profile_image) || '/images/default-avatar.svg';

        // حساب الإحصائيات
        const [followersRes, postsRes, offersRes] = await Promise.all([
            supabase.from('teacher_followers').select('*', { count: 'exact', head: true }).eq('teacher_id', teacher_id).then(r => r).catch(e => ({ count: 0 })),
            supabase.from('posts').select('*', { count: 'exact', head: true }).eq('teacher_id', teacher_id).then(r => r).catch(e => ({ count: 0 })),
            supabase.from('offers').select('*', { count: 'exact', head: true }).eq('teacher_id', teacher_id).then(r => r).catch(e => ({ count: 0 }))
        ]);

        let followersCount = followersRes?.count || 0;
        try {
            const localList = await loadLocalTeacherFollowers();
            const localCount = localList.filter(f => parseInt(f.teacher_id) === parseInt(teacher_id)).length;
            if (localCount > followersCount) followersCount = localCount;
        } catch (lErr) {}

        teacher.followers_count = followersCount;
        teacher.posts_count = postsRes?.count || 0;
        teacher.offers_count = offersRes?.count || 0;
        
        let isFollowing = false;
        if (userId && userType) {
            try {
                const { data: followingRes } = await supabase
                    .from('teacher_followers')
                    .select('id')
                    .eq('teacher_id', teacher_id)
                    .eq('follower_id', userId)
                    .eq('follower_type', userType)
                    .limit(1);
                isFollowing = followingRes && followingRes.length > 0;
            } catch (dbErr) {}

            if (!isFollowing) {
                try {
                    const localList = await loadLocalTeacherFollowers();
                    isFollowing = localList.some(
                        f => parseInt(f.teacher_id) === parseInt(teacher_id) && parseInt(f.follower_id) === parseInt(userId) && f.follower_type === userType
                    );
                } catch (lErr) {}
            }
        }
        
        teacher.is_following = isFollowing;

        res.json({ success: true, teacher });
    } catch (error) {
        logger.error('خطأ في جلب ملف الأستاذ العام:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب مستويات التعليم المتاحة
// ============================================================
router.get('/public/teaching-levels', async (req, res) => {
    try {
        const { data: teachers, error } = await supabase
            .from('teachers')
            .select('teaching_level')
            .eq('status', 'approved')
            .not('teaching_level', 'is', null);

        if (error) throw error;

        const levels = [...new Set(teachers.map(t => t.teaching_level).filter(Boolean))];
        
        const levelMap = {
            'primary_all': 'التعليم الابتدائي',
            'primary_1': 'السنة الأولى ابتدائي',
            'primary_2': 'السنة الثانية ابت��ائي',
            'primary_3': 'السنة الثالثة ابتدائي',
            'primary_4': 'السنة الرابعة ابتدائي',
            'primary_5': 'السنة الخامسة ابتدائي',
            '5eme_pri': 'خامسة ابتدائي',
            'middle_all': 'التعليم المتوسط',
            '1ere_am': 'أولى متوسط',
            '2eme_am': 'ثانية متوسط',
            '3eme_am': 'ثالثة متوسط',
            '4eme_am': 'رابعة متوسط (BEM)',
            'bem': 'رابعة متوسط (BEM)',
            'secondary_all': 'التعليم الثانوي',
            '1ere_as': 'أولى ثانوي',
            '2eme_as': 'ثانية ثانوي',
            '3eme_as': 'ثالثة ثانوي (BAC)',
            'bac': 'ثالثة ثانوي (BAC)',
            'university': 'تعليم جامعي / عالي',
            '1ere_uni': 'أولى جامعي (L1)',
            '2eme_uni': 'ثانية جامعي (L2)',
            '2ere_uni': 'ثانية جامعي (L2)',
            '3eme_uni': 'ثالثة جامعي (L3)',
            '3ere_uni': 'ثالثة جامعي (L3)',
            'master': 'ماستر',
            'doctorat': 'دكتوراه',
            'other': 'مستوى آخر'
        };

        const formattedLevels = levels.map(level => ({
            value: level,
            label: levelMap[level] || level
        }));

        res.json(formattedLevels);
    } catch (error) {
        logger.error('خطأ في جلب مستويات التعليم:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب الرصيد والأرباح والمدفوعات المستحقة
// ============================================================
router.get('/balance/:teacher_id', authenticate, authorize(['teacher']), [
    param('teacher_id').isInt({ allow_leading_zeroes: true, min: -1 }).withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);
        if (teacher_id === -1 || req.user.userId === -1 || req.user.userId === '-1') {
            return res.json({ 
                success: true, 
                balance: 0, 
                total_earned: 0, 
                pending_withdraw: 0, 
                total_withdrawn: 0, 
                sessions: [] 
            });
        }
        
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        if (req.user.userId !== teacher_id && req.user.userId !== 0 && req.user.email !== ADMIN_EMAIL) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المعلومات' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        }

        // 1. جلب جميع دروس وعروض هذا الأستاذ
        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacher_id);

        if (offersError) {
            logger.error('خطأ في جلب دروس الأستاذ:', offersError.message);
        }

        const offerIds = (offers || []).map(o => o.id);
        const offersMap = new Map();
        (offers || []).forEach(o => offersMap.set(o.id, o));

        let allSessions = [];
        if (offerIds.length > 0) {
            // 2. جلب جميع الجلسات (المعلقة والمدفوعة) المرتبطة بحصص الأستاذ
            const { data: sessions, error: sessionsError } = await supabase
                .from('stream_subscriptions')
                .select(`
                    id,
                    offer_id,
                    student_id,
                    status,
                    total_amount_paid,
                    teacher_total_escrow,
                    created_at,
                    session_number,
                    plan_type,
                    total_sessions,
                    completed_sessions,
                    students:student_id (
                        id,
                        full_name,
                        phone
                    )
                `)
                .in('offer_id', offerIds)
                .eq('status', 'active')
                .order('created_at', { ascending: false });

            if (sessionsError) {
                logger.error('خطأ في جلب الاشتراكات:', sessionsError.message);
            } else if (sessions) {
                const { data: streamSessions, error: streamSessionsError } = await supabase
                    .from('stream_sessions')
                    .select('id, offer_id, teacher_id, session_number, title, session_date, duration_minutes, price_per_session, status, stream_url, completed_at, actual_duration_seconds')
                    .in('offer_id', offerIds)
                    .order('session_number', { ascending: true });
                if (streamSessionsError) logger.error('خطأ في جلب جلسات البث:', streamSessionsError.message);
                const streamByOffer = new Map();
                for (const session of streamSessions || []) {
                    if (!streamByOffer.has(session.offer_id)) streamByOffer.set(session.offer_id, session);
                }
                allSessions = sessions.map(s => {
                    const streamSession = streamByOffer.get(s.offer_id) || {};
                    s = { ...s, ...streamSession };
                    const offer = offersMap.get(s.offer_id);
                    const offerPrice = parseFloat(offer?.price || 0);
                    let earned = (s.teacher_earned !== undefined && s.teacher_earned !== null && Number(s.teacher_earned) > 0)
                        ? Number(s.teacher_earned)
                        : (Number(s.payment_amount || 0) > 0 ? Math.max(0, Number(s.payment_amount) - 50) : Math.max(0, offerPrice - 50));
                    
                    return {
                        id: s.id,
                        offer_id: s.offer_id,
                        student_id: s.student_id,
                        payment_status: s.status === 'active' ? 'pending_stream' : s.status,
                        payment_amount: Number(s.total_amount_paid || 0),
                        teacher_earned: Number(s.teacher_total_escrow || 0) || earned,
                        created_at: s.created_at,
                        session_number: s.session_number || 1,
                        plan_type: s.plan_type || '1_day',
                        total_sessions: Number(s.total_sessions) || 1,
                        completed_sessions: Number(s.completed_sessions) || 0,
                        session_date: s.session_date || offer?.offer_date,
                        duration_minutes: Number(s.duration_minutes) || 60,
                        status: s.status || 'upcoming',
                        title: s.title || offer?.subject_name,
                        offers: {
                            subject_name: offer?.subject_name || 'درس خصوصي',
                            price: offerPrice,
                            offer_date: offer?.offer_date,
                            session_number: s.session_number || 1,
                            plan_type: s.plan_type || '1_day',
                            total_sessions: Number(s.total_sessions) || 1,
                            completed_sessions: Number(s.completed_sessions) || 0,
                            session_date: s.session_date || offer?.offer_date,
                            duration_minutes: Number(s.duration_minutes) || 60,
                            status: s.status || 'upcoming'
                        },
                        student_name: s.students?.full_name || 'طالب منصة ZoomDz'
                    };
                });
            }
        }

        // 3. حساب الرصيد المعلق الفعلي من الجلسات قيد الانتظار
        let calculatedPending = 0;
        allSessions.forEach(s => {
            if (s.payment_status === 'pending_stream' || s.payment_status === 'pending' || s.status === 'active') {
                calculatedPending += parseFloat(s.teacher_earned || 0);
            }
        });

        // الرصيد المعلق المخزن في teachers هو المصدر المحاسبي المعتمد.
        // لا نستخدم Math.max مع قيمة محسوبة من sessions لأنها قديمة بعد الاسترداد
        // وتعيد إظهار مبلغ الحصة المستردة (مثل 1000 بدلاً من 750).
        const finalPending = Number.isFinite(Number(teacher.pending_withdraw))
            ? parseFloat(teacher.pending_withdraw)
            : calculatedPending;

        res.json({
            success: true,
            balance: parseFloat(teacher.balance || 0),
            total_earned: parseFloat(teacher.total_earned || 0),
            pending_withdraw: finalPending,
            total_withdrawn: parseFloat(teacher.total_withdrawn || 0),
            sessions: allSessions
        });
    } catch (error) {
        logger.error('خطأ في جلب الرصيد والمدفوعات المستحقة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// طلب إرسال رمز التحقق (OTP) إلى بريد الأستاذ لسحب الأرباح
// ============================================================
router.post('/request-withdraw-otp', authenticate, authorize(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('amount').isFloat({ min: 1000, max: 1000000 }).withMessage('المبلغ غير صالح (الحد الأدنى 1000 دج)')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, amount } = req.body;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بطلب السحب' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        }

        if (!teacher.email) {
            return res.status(400).json({ success: false, error: 'لا يوجد بريد إلكتروني مسجل لحسابك' });
        }

        if ((teacher.balance || 0) < parseFloat(amount)) {
            return res.status(400).json({ 
                success: false, 
                error: `الرصيد غير كافٍ. رصيدك الحالي: ${teacher.balance || 0} دج` 
            });
        }

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

        // توليد رمز تحقق عشوائي مكون من 6 أرقام
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 10 * 60 * 1000; // صلاحية 10 دقائق

        // حفظ الرمز في الذاكرة
        withdrawalOtpStore.set(parseInt(teacher_id), {
            code: otpCode,
            amount: parseFloat(amount),
            expiresAt
        });

        // إرسال البريد الإلكتروني
        await sendWithdrawalOtpEmail(teacher.email, teacher.full_name || 'الأستاذ', otpCode, amount);

        // إخفاء البريد جزئياً للخصوصية
        const parts = teacher.email.split('@');
        const maskedEmail = parts[0].length > 2 ? parts[0].substring(0, 2) + '***@' + parts[1] : '***@' + parts[1];

        res.json({
            success: true,
            message: `تم إرسال رمز التحقق المكون من 6 أرقام إلى بريدك الإلكتروني (${maskedEmail})`,
            masked_email: maskedEmail
        });
    } catch (error) {
        logger.error('خطأ في إرسال رمز التحقق للسحب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء إرسال رمز التحقق' });
    }
});

// ============================================================
// طلب سحب تلقائي عبر SofizPay أو يدوي عبر CCP (يتطلب رمز التحقق OTP)
// ============================================================
router.post('/withdraw-request', authenticate, authorize(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('amount').isFloat({ min: 1000, max: 1000000 }).withMessage('المبلغ غير صالح (الحد الأدنى 1000 دج)'),
    body('otp_code').isLength({ min: 6, max: 6 }).withMessage('رمز التحقق يجب أن يتكون من 6 أرقام')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, amount, method, otp_code } = req.body;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بطلب السحب' });
        }

        // �� التحقق من صحة رمز التحقق OTP
        const storedOtp = withdrawalOtpStore.get(parseInt(teacher_id));
        if (!storedOtp) {
            return res.status(400).json({
                success: false,
                error: 'لم يتم العثور على رمز تحقق نشط. يرجى الضغط على "إرسال كود التحقق" أولاً.'
            });
        }

        if (Date.now() > storedOtp.expiresAt) {
            withdrawalOtpStore.delete(parseInt(teacher_id));
            return res.status(400).json({
                success: false,
                error: 'انتهت صلاحية رمز التحقق (10 دقائق). يرجى طلب رمز جديد.'
            });
        }

        if (String(storedOtp.code).trim() !== String(otp_code).trim()) {
            return res.status(400).json({
                success: false,
                error: 'رمز التحقق غير صحيح. يرجى التأكد من الرمز المكون من 6 أرقام المرسل إلى بريدك.'
            });
        }

        // مسح الرمز بعد النجاح لمنع إعادة استخدامه
        withdrawalOtpStore.delete(parseInt(teacher_id));

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        }

        const withdrawMethod = method || 'ccp';

        if (withdrawMethod === 'sofizpay') {
            return res.status(400).json({
                success: false,
                error: 'طريقة السحب عبر SofizPay قيد الصيانة حالياً وستكون متاحة لاحقاً. يرجى اختيار السحب عبر حساب CCP.'
            });
        }

        if (withdrawMethod === 'ccp' && !teacher.ccp_account) {
            return res.status(400).json({ 
                success: false, 
                error: 'يرجى إدخال رقم حساب CCP في إعدادات الحساب قبل طلب السحب',
                needs_ccp: true
            });
        }

        if ((teacher.balance || 0) < amount) {
            return res.status(400).json({ 
                success: false, 
                error: `الرصيد غير كافٍ. رصيدك الحالي: ${teacher.balance} دج` 
                + (withdrawMethod === 'ccp' ? ' (الرجاء التأكد من رصيدك المتاح)' : '')
            });
        }

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

        // ✅ التحقق من تكرار السحب (مرة كل 10 أيام كحد أقصى)
        const tenDaysAgo = new Date();
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

        try {
            const { data: recentRequest, error: recentError } = await supabase
                .from('withdraw_requests')
                .select('id, created_at')
                .eq('teacher_id', teacher_id)
                .gte('created_at', tenDaysAgo.toISOString())
                .order('created_at', { ascending: false })
                .limit(1);

            if (recentRequest && recentRequest.length > 0) {
                const lastDate = new Date(recentRequest[0].created_at);
                const nextAvailableDate = new Date(lastDate);
                nextAvailableDate.setDate(nextAvailableDate.getDate() + 10);
                
                const diffMs = nextAvailableDate - new Date();
                const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

                return res.status(400).json({
                    success: false,
                    error: `⚠️ يمكنك تقديم طلب سحب جديد مرة كل 10 أيام فقط. تاريخ آخر طلب: ${lastDate.toLocaleDateString('ar-EG')}. يرجى الانتظار ${diffDays} يومًا إضافيًا.`
                });
            }
        } catch (e) {
            logger.error('Error checking recent withdrawal frequency:', e.message);
        }

        // جلب نسبة عمولة السحب للأستاذ من الإعدادات (افتراضياً 1%)
        let commission_rate = 1;
        try {
            const { data: revSettings } = await supabase
                .from('platform_settings')
                .select('value')
                .eq('key', 'revenue_settings')
                .maybeSingle();
            if (revSettings && revSettings.value && revSettings.value.teacher_withdrawal_commission !== undefined) {
                const val = parseFloat(revSettings.value.teacher_withdrawal_commission);
                if (!isNaN(val)) commission_rate = val;
            }
        } catch (e) {
            logger.error('Error fetching teacher withdrawal commission from settings:', e.message);
        }

        const requestedAmount = parseFloat(amount);
        const commission_amount = Math.round((requestedAmount * commission_rate) / 100);
        const payout_amount = requestedAmount - commission_amount;
        const commission_desc = `المبلغ الأصلي: ${requestedAmount} دج | خصم ${commission_rate}% رسوم سحب (${commission_amount} دج) | الصافي: ${payout_amount} دج`;
        const final_desc = `${commission_desc} | طريقة السحب: ${withdrawMethod === 'sofizpay' ? 'SofiZPay (فوري)' : 'CCP (خلال 7 أيام)'}`;

        const { data: updateRes, error: updateErr } = await supabase.from('teachers').update({
            balance: (teacher.balance || 0) - requestedAmount,
            pending_withdraw: (teacher.pending_withdraw || 0) + requestedAmount
        }).eq('id', teacher_id).eq('balance', teacher.balance).select();

        if (updateErr || !updateRes || updateRes.length === 0) {
            return res.status(409).json({ success: false, error: 'حدث تغيير في الرصيد أثناء المعالجة، يرجى المحاولة مرة أخرى' });
        }

        const withdrawRequest = await insert('withdraw_requests', {
            teacher_id: parseInt(teacher_id),
            amount: payout_amount,
            original_amount: requestedAmount,
            fee_amount: commission_amount,
            sofizpay_public_key: withdrawMethod === 'sofizpay' ? teacher.sofizpay_public_key : null,
            ccp_account: withdrawMethod === 'ccp' ? teacher.ccp_account : null,
            description: final_desc,
            status: 'pending',
            created_at: new Date().toISOString()
        });

        if (!withdrawRequest) {
            // Rollback if insert fails
            await supabase.from('teachers').update({
                balance: teacher.balance,
                pending_withdraw: teacher.pending_withdraw
            }).eq('id', teacher_id);
            return res.status(500).json({ success: false, error: 'فشل في إنشاء طلب السحب' });
        }

        await insert('notifications', {
            user_id: teacher_id,
            user_type: 'teacher',
            title: '💰 طلب سحب جديد',
            message: `تم تقديم طلب سحب بمبلغ ${amount} دج عبر ${withdrawMethod === 'sofizpay' ? 'SofizPay' : 'حساب CCP'} (${commission_desc})`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        if (withdrawMethod === 'sofizpay') {
            setTimeout(async () => {
                try {
                    const { default: SofizPay } = require('sofizpay-sdk-js');
                    const sofiz = new SofizPay();
                    
                    const result = await sofiz.submit({
                        secretkey: process.env.SOFIZPAY_SECRET_KEY,
                        destinationPublicKey: teacher.sofizpay_public_key,
                        amount: parseFloat(payout_amount), // تحويل الصافي للأستاذ بعد اقتطاع عمولة المنصة
                        memo: `payout - teacher ${teacher_id} - withdraw ${withdrawRequest.id}`
                    });
                    
                    if (result.success) {
                        await update('withdraw_requests', withdrawRequest.id, {
                            status: 'completed',
                            sofizpay_transaction_id: result.transactionId || result.data?.transactionId,
                            sofizpay_status: 'success',
                            processed_at: new Date().toISOString()
                        });
                        
                        const latestTeacher = await getOne('teachers', 'id', teacher_id);
                        if (latestTeacher) {
                            await update('teachers', teacher_id, {
                                total_withdrawn: (latestTeacher.total_withdrawn || 0) + parseFloat(requestedAmount),
                                pending_withdraw: Math.max(0, (latestTeacher.pending_withdraw || 0) - parseFloat(requestedAmount))
                            });
                        }
                        
                        await insert('notifications', {
                            user_id: teacher_id,
                            user_type: 'teacher',
                            title: '✅ تم التحويل بنجاح',
                            message: `تم تحويل مبلغ ${payout_amount} دج إلى محفظتك SofizPay (بعد اقتطاع عمولة المنصة ${commission_rate}%)`,
                            is_read: false,
                            created_at: new Date().toISOString()
                        });
                        
                        console.log(`✅ تم التحويل التلقائي لـ ${payout_amount} دج للأستاذ ${teacher_id}`);
                    }
                } catch (error) {
                    logger.error('خطأ في التحويل التلقائي عبر SofizPay:', error.message);
                    await update('withdraw_requests', withdrawRequest.id, {
                        sofizpay_status: 'failed',
                        description: `فشل التحويل التلقائي: ${error.message} (${commission_desc})`
                    });
                    const latestTeacher = await getOne('teachers', 'id', teacher_id);
                    if (latestTeacher) {
                        await update('teachers', teacher_id, {
                            balance: (latestTeacher.balance || 0) + parseFloat(requestedAmount),
                            pending_withdraw: Math.max(0, (latestTeacher.pending_withdraw || 0) - parseFloat(requestedAmount))
                        });
                    }
                }
            }, 2000);
        } else {
            // CCP Withdrawal request is logged and left for admin review (up to 7 days)
            await insert('notifications', {
                user_id: teacher_id,
                user_type: 'teacher',
                title: '⏳ طلب سحب CCP قيد المراجعة',
                message: `لقد اخترت السحب عبر حساب CCP بمبلغ ${amount} دج. ستتم معالجة الطلب وتحويله خلال 7 أيام كحد أقصى.`,
                is_read: false,
                created_at: new Date().toISOString()
            });
        }

        res.json({ 
            success: true, 
            message: withdrawMethod === 'sofizpay' 
                ? 'تم تقديم طلب السحب بنجاح، سيتم تحويل الرصيد إلى محفظتك SofizPay تلقائياً خلال لحظات'
                : 'تم تقديم طلب السحب عبر حساب CCP بنجاح، سيقوم المشرف بمعالجته وتحويل المبلغ خلال 7 أيام كأقصى حد',
            request: withdrawRequest 
        });
    } catch (error) {
        logger.error('خطأ في طلب السحب:', error.message);
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

        if (req.user.userId !== teacher_id && req.user.role !== 'admin' && req.user.email !== ADMIN_EMAIL) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بدرس هذه الطلبات' });
        }

        const { data, error } = await supabase
            .from('withdraw_requests')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json(data || []);
    } catch (error) {
        logger.error('خطأ في جلب طلبات السحب:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب دروس الأستاذ
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

        if (req.user.userId !== teacher_id && req.user.role !== 'admin' && req.user.email !== ADMIN_EMAIL) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بدرس هذه الدروس' });
        }

        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.set('Pragma', 'no-cache');

        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('offer_date', { ascending: false });

        if (offersError) {
            logger.error('خطأ في جلب الدروس:', offersError.message);
            return res.status(500).json([]);
        }

        if (!offers || offers.length === 0) {
            return res.json([]);
        }

        const formatted = offers.map(offer => {
            const views = getViewCount('offer', offer.id, offer.views_count || offer.views || 0);
            return {
                id: offer.id,
                teacher_id: offer.teacher_id,
                subject_name: offer.subject_name,
                duration: offer.duration,
                offer_date: offer.offer_date,
                price: offer.price,
                is_free: (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0,
                status: offer.status,
                education_level: offer.education_level,
                room_name: offer.room_name || null,
                room_password: offer.room_password || null,
                stream_url: offer.stream_url || null,
                stream_platform: offer.stream_platform || 'mirotalk',
                views_count: views,
                views: views,
                created_at: offer.created_at
            };
        });

        res.json(formatted);
    } catch (error) {
        logger.error('خطأ في جلب دروس الأستاذ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب درس محدد للأستاذ
// ============================================================
router.get('/offer/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف الدرس غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بدرس هذا الدرس' });
        }

        const { count: studentsCount, error: countError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        if (countError) {
            logger.error('خطأ في جلب عدد الطلاب:', countError.message);
        }

        const views = getViewCount('offer', offer.id, offer.views_count || offer.views || 0);

        res.json({
            ...offer,
            views_count: views,
            views: views,
            room_password: offer.room_password || null,
            jitsi_room_name: offer.room_name || null,
            jitsi_room_url: offer.stream_url || null,
            students_count: studentsCount || 0
        });
    } catch (error) {
        logger.error('خطأ في جلب الدرس:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث كلمة مرور الدرس
// ============================================================
router.put('/offer/update-password/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف الدرس غير صالح'),
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
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        await update('offers', offer_id, {
            room_password: password
        });

        res.json({
            success: true,
            message: 'تم تحديث كلمة المرور بنجاح',
            new_password: password
        });
    } catch (error) {
        logger.error('خطأ في تحديث كلمة المرور:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب إحصائيات الأستاذ
// ============================================================
router.get('/stats/:teacher_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);
        
        if (req.user.userId !== teacher_id && req.user.role !== 'admin' && req.user.email !== ADMIN_EMAIL) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { count: totalOffers, error: offersError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('teacher_id', teacher_id);

        if (offersError) {
            logger.error('خطأ في جلب عدد الدروس:', offersError.message);
        }

        const { count: activeOffers, error: activeError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('teacher_id', teacher_id)
            .eq('status', 'live');

        if (activeError) {
            logger.error('خطأ في جلب عدد الدروس النشطة:', activeError.message);
        }

        const { data: offers, error: offersDataError } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacher_id);

        if (offersDataError) {
            logger.error('خطأ في جلب دروس الأستاذ للإحصائيات:', offersDataError.message);
        }

        let totalStudents = 0;
        let completedSessions = 0;

        if (offers && offers.length > 0) {
            const offerIds = offers.map(o => o.id);

            const { data: studentRows, error: studentsError } = await supabase
                .from('sessions')
                .select('student_id')
                .in('offer_id', offerIds)
                .in('payment_status', ['paid', 'pending_stream', 'completed']);

            if (studentsError) {
                logger.error('خطأ في جلب عدد الطلاب:', studentsError.message);
            } else {
                totalStudents = new Set((studentRows || []).map(row => row.student_id).filter(Boolean)).size;
            }

            const { count: completedCount, error: completedError } = await supabase
                .from('sessions')
                .select('*', { count: 'exact', head: true })
                .in('offer_id', offerIds)
                .eq('payment_status', 'completed');

            if (completedError) {
                logger.error('خطأ في جلب عدد الحصص المكتملة:', completedError.message);
            } else {
                completedSessions = completedCount || 0;
            }
        }

        res.json({
            total_offers: totalOffers || 0,
            active_offers: activeOffers || 0,
            total_students: totalStudents,
            completed_sessions: completedSessions
        });
    } catch (error) {
        logger.error('خطأ في جلب إحصائيات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب قائمة الطلاب المسجلين في دروس الأستاذ
// ============================================================
router.get('/students/:teacher_id', authenticate, authorize(['teacher']), [
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = parseInt(req.params.teacher_id);

        if (req.user.userId !== teacher_id && req.user.role !== 'admin' && req.user.email !== ADMIN_EMAIL) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك ب��رس هذه المعلومات' });
        }

        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacher_id);

        if (offersError) {
            logger.error('خطأ في جلب دروس الأستاذ:', offersError.message);
            return res.status(500).json([]);
        }

        if (!offers || offers.length === 0) {
            return res.json([]);
        }

        const offerIds = offers.map(o => o.id);

        const { data: sessions, error: sessionsError } = await supabase
            .from('sessions')
            .select(`
                id,
                student_id,
                offer_id,
                payment_status,
                created_at,
                students:student_id (
                    id,
                    full_name,
                    email,
                    phone,
                    education_level
                ),
                offers:offer_id (
                    subject_name
                )
            `)
            .in('offer_id', offerIds)
            .eq('payment_status', 'paid')
            .order('created_at', { ascending: false });

        if (sessionsError) {
            logger.error('خطأ في ��لب الجلسات:', sessionsError.message);
            return res.status(500).json([]);
        }

        const formatted = (sessions || []).map(session => ({
            session_id: session.id,
            student_id: session.student_id,
            student_name: session.students?.full_name || 'غير معروف',
            student_email: session.students?.email || '',
            student_phone: session.students?.phone || '',
            student_education_level: session.students?.education_level || '',
            offer_id: session.offer_id,
            offer_subject: session.offers?.subject_name || 'غير معروف',
            payment_status: session.payment_status,
            booked_at: session.created_at
        }));

        res.json(formatted);
    } catch (error) {
        logger.error('خطأ في جلب طلاب الأستاذ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ إكمال الملف الشخصي للأستاذ (الخطوة الثانية بعد التسجيل)
// ============================================================
router.post('/complete-profile', authenticate, authorize(['teacher']), upload.fields([
    { name: 'profile_image', maxCount: 1 },
    { name: 'diploma_image', maxCount: 1 },
    { name: 'id_image', maxCount: 1 }
]), validateUploadedFiles, [
    body('teacher_id').optional(),
    body('phone').optional({ checkFalsy: true }).trim().custom((val) => {
        if (!isValidDzPhone(val)) {
            throw new Error('⚠️ رقم الهاتف يجب أن يكون برقم جزائري ��حيح (مثال: 0550123456 أو 0660123456 أو 0770123456)');
        }
        return true;
    }),
    body('specialization').optional({ checkFalsy: true }).isLength({ max: 100 }),
    body('bio').optional({ checkFalsy: true }).isLength({ max: 500 }),
    body('experience').optional({ checkFalsy: true }),
    body('teaching_level').optional({ checkFalsy: true })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        let { teacher_id, phone, specialization, bio, experience, teaching_level } = req.body;

        if (!teacher_id || isNaN(teacher_id)) {
            teacher_id = req.user.userId;
        } else {
            teacher_id = parseInt(teacher_id);
        }

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الحساب' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        // fall back to existing database values if empty or missing in request body
        phone = (phone && String(phone).trim()) ? String(phone).trim() : (teacher.phone || '');
        specialization = (specialization && String(specialization).trim()) ? String(specialization).trim() : (teacher.specialization || '');
        bio = (bio && String(bio).trim()) ? String(bio).trim() : (teacher.bio || '');
        experience = (experience && String(experience).trim()) ? String(experience).trim() : (teacher.experience || '');
        teaching_level = (teaching_level && String(teaching_level).trim()) ? String(teaching_level).trim() : (teacher.teaching_level || '');

        if (!phone) {
            return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب' });
        }
        if (!specialization) {
            return res.status(400).json({ success: false, error: 'التخصص مطلوب' });
        }
        if (!bio) {
            return res.status(400).json({ success: false, error: 'النبذة التعريفية مطلوبة' });
        }
        if (!experience) {
            return res.status(400).json({ success: false, error: 'سنوات الخبرة مطلوبة' });
        }
        if (!teaching_level) {
            return res.status(400).json({ success: false, error: 'المستوى الدراسي مطلوب' });
        }

        // ✅ رفع الملفات (اختيارية)
        let profile_image = teacher.profile_image;
        let diploma_image = teacher.diploma_image;
        let id_image = teacher.id_image;

        if (req.files && req.files['profile_image'] && req.files['profile_image'][0]) {
            const uploaded = await uploadToSupabase(req.files['profile_image'][0], 'teachers', teacher.profile_image);
            if (uploaded) {
                profile_image = uploaded.url;
            }
        }

        let newDocsUploaded = false;
        if (req.files && req.files['diploma_image'] && req.files['diploma_image'][0]) {
            const uploaded = await uploadToSupabase(req.files['diploma_image'][0], 'diplomas', teacher.diploma_image);
            if (uploaded) {
                diploma_image = uploaded.url;
                newDocsUploaded = true;
            }
        }

        if (req.files && req.files['id_image'] && req.files['id_image'][0]) {
            const uploaded = await uploadToSupabase(req.files['id_image'][0], 'ids', teacher.id_image);
            if (uploaded) {
                id_image = uploaded.url;
                newDocsUploaded = true;
            }
        }

        // ✅ تحديث الملف الشخصي الكامل (دون إجبار على رفع المستندات)
        const updateData = {
            phone,
            specialization,
            bio,
            experience,
            teaching_level,
            profile_image,
            profile_url: profile_image,
            diploma_image,
            id_image,
            status: 'approved',
            profile_completion: true,
            updated_at: new Date().toISOString()
        };

        const updatedTeacher = await update('teachers', teacher_id, updateData);
        
        if (!updatedTeacher) {
             throw new Error('فشل تحديث بيانات الأستاذ في قاعدة البيانات');
        }

        const finalTeacher = updatedTeacher;

        // ✅ إرسال إشعار للمدير إذا قام بتزويد مستندات التوثيق
        if (newDocsUploaded) {
            try {
                await insert('notifications', {
                    user_id: 1,
                    user_type: 'admin',
                    title: '📜 طلب توثيق واستحقاق الشارة الذهبية',
                    message: `قام الأستاذ ${teacher.full_name} برفع وثائقه (البطاقة/الشهادة) للحصول على شارة الأستاذ المعتمد 👑.`,
                    is_read: false,
                    created_at: new Date().toISOString()
                });
            } catch (notifError) {
                logger.error('⚠️ خطأ في إرسال إشعار للمدير:', notifError.message);
            }
        }

        const { generateToken } = require('../utils/jwt');
        const token = generateToken(finalTeacher.id, 'teacher', finalTeacher.email);

        res.json({
            success: true,
            message: newDocsUploaded 
                ? '✅ تم تحديث بياناتك ورفع وثائق التوثيق بنجاح! سيتم مراجعتها لمنحك الشارة الذهبية.'
                : '✅ تم تحديث ملفك الشخصي بنجاح!',
            teacher_id: teacher_id,
            profile_completion: true,
            token: token,
            user: processUserProfile({
                ...finalTeacher,
                role: 'teacher',
                status: 'approved',
                is_certified: Boolean(finalTeacher.is_certified)
            }, 'teacher')
        });

    } catch (error) {
        logger.error('خطأ في إكمال الملف الشخصي:', {
            error: error.message,
            stack: error.stack,
            userId: req.user.userId,
            body: req.body
        });
        res.status(500).json({
            success: false,
            error: `❌ حدث خطأ في الخادم أثناء إكمال الملف الشخصي: ${error.message || error}`,
            details: error.stack || error.message || error
        });
    }
});

// ============================================================
// ✅ طلب ترقية الحساب إلى أستاذ معتمد (رفع أو التقاط بطاقة الهوية والشهادة)
// ============================================================
router.post('/request-upgrade', authenticate, authorize(['teacher']), upload.fields([
    { name: 'diploma_image', maxCount: 1 },
    { name: 'id_image', maxCount: 1 }
]), async (req, res) => {
    try {
        const teacher_id = req.user.userId;
        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'حساب الأستاذ غير موجود' });
        }

        if (teacher.is_certified === true) {
            return res.status(400).json({ success: false, error: 'حسابك معتمد بالفعل ومزود بالشارة الذهبية!' });
        }

        if (!teacher.is_vip) {
            return res.status(403).json({ success: false, error: 'يجب عليك دفع رسوم الترقية أولاً قبل رفع الوثائق.' });
        }

        let diploma_image = teacher.diploma_image;
        let id_image = teacher.id_image;
        let newDocsUploaded = false;

        // Diploma image (file or base64)
        if (req.files && req.files['diploma_image'] && req.files['diploma_image'][0]) {
            const uploaded = await uploadToSupabase(req.files['diploma_image'][0], 'diplomas', teacher.diploma_image);
            if (uploaded) {
                diploma_image = uploaded.url;
                newDocsUploaded = true;
            }
        } else if (req.body.diploma_image_base64) {
            try {
                const base64Data = req.body.diploma_image_base64.replace(/^data:image\/\w+;base64,/, '');
                const buffer = Buffer.from(base64Data, 'base64');
                const mockFile = {
                    buffer: buffer,
                    originalname: `diploma_${teacher_id}_${Date.now()}.jpg`,
                    mimetype: 'image/jpeg',
                    size: buffer.length
                };
                const uploaded = await uploadToSupabase(mockFile, 'diplomas', teacher.diploma_image);
                if (uploaded) {
                    diploma_image = uploaded.url;
                    newDocsUploaded = true;
                }
            } catch (imgErr) {
                logger.error('Error processing diploma base64:', imgErr.message);
            }
        }

        // ID image (file or base64)
        if (req.files && req.files['id_image'] && req.files['id_image'][0]) {
            const uploaded = await uploadToSupabase(req.files['id_image'][0], 'ids', teacher.id_image);
            if (uploaded) {
                id_image = uploaded.url;
                newDocsUploaded = true;
            }
        } else if (req.body.id_image_base64) {
            try {
                const base64Data = req.body.id_image_base64.replace(/^data:image\/\w+;base64,/, '');
                const buffer = Buffer.from(base64Data, 'base64');
                const mockFile = {
                    buffer: buffer,
                    originalname: `id_${teacher_id}_${Date.now()}.jpg`,
                    mimetype: 'image/jpeg',
                    size: buffer.length
                };
                const uploaded = await uploadToSupabase(mockFile, 'ids', teacher.id_image);
                if (uploaded) {
                    id_image = uploaded.url;
                    newDocsUploaded = true;
                }
            } catch (imgErr) {
                logger.error('Error processing ID base64:', imgErr.message);
            }
        }

        if (!newDocsUploaded) {
            return res.status(400).json({ success: false, error: 'يرجى التقاط أو رفع صورة بطاقة الهوية الوطنية وصورة الشهادة والدبلوم لتقديم طلب الترقية' });
        }

        const updateData = {
            diploma_image,
            id_image,
            updated_at: new Date().toISOString()
        };

        const updatedTeacher = await update('teachers', teacher_id, updateData);

        // إرسال إشعار للمدير
        try {
            await insert('notifications', {
                user_id: 1,
                user_type: 'admin',
                title: '📜 طلب ترقية إلى أستاذ معتمد',
                message: `قام الأستاذ ${teacher.full_name} بتقديم طلب ترقية والتقاط/رفع وثائقه للحصول على الشارة الذهبية 👑.`,
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (notifErr) {
            logger.error('⚠️ خطأ في إرسال إشعار الترقية للمدير:', notifErr.message);
        }

        const processed = processUserProfile({
            ...updatedTeacher,
            role: 'teacher',
            status: 'approved',
            is_certified: Boolean(updatedTeacher.is_certified)
        }, 'teacher');

        res.json({
            success: true,
            message: '🚀 تم إرسال طلب الترقية والوثائق بنجاح! سيتم مراجعتها من قِبل إدارة المنصة لمنحك الشارة الذهبية (أستاذ معتمد).',
            user: processed
        });

    } catch (error) {
        logger.error('❌ خطأ في طلب ترقية الأستاذ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب تقرير تحرير المستحقات للحصص المكتملة
// ============================================================
router.get('/teacher/plan-releases/:teacher_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data: releases, error } = await supabase
            .from('stream_escrow_releases')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('created_at', { ascending: false });

        if (error) {
            console.warn('تعذر جلب stream_escrow_releases:', error.message);
            return res.json({ success: true, releases: [] });
        }

        res.json({
            success: true,
            releases: releases || []
        });
    } catch (error) {
        logger.error('خطأ في جلب تقرير تحرير المستحقات:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ تحرير مستحقات حصة مكتملة يدوياً أو بعد انتهاء الجلسة
// ============================================================
router.post('/teacher/complete-session-escrow', authenticate, authorize(['teacher']), [
    body('offer_id').isInt().withMessage('��عرف الدرس غير صالح'),
    body('session_number').optional().isInt().withMessage('رقم الحصة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, session_number } = req.body;
        const offer = await getOne('offers', 'id', offer_id);

        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحرير هذا الدرس' });
        }

        const { releasePlanSessionEscrow } = require('../utils/streamVerification');
        const result = await releasePlanSessionEscrow(offer_id, session_number || null);

        if (!result.success) {
            return res.status(400).json(result);
        }

        res.json({
            success: true,
            message: `✅ تم تحرير مستحقات الحصة رقم (${result.session_number}) بنجاح بمبلغ ${result.amount_released} دج`,
            data: result
        });
    } catch (error) {
        logger.error('خطأ في تحرير مستحقات الحصة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ⭐ ترقية حساب الأستاذ للشارة الذهبية (700 دج / شهر)
// ============================================================
router.post('/upgrade-vip', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacherId = req.user.userId;
        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'حساب الأستاذ غير موجود' });
        }

        const VIP_COST = 700;
        const currentBalance = parseFloat(teacher.balance || 0);

        if (currentBalance < VIP_COST) {
            return res.status(400).json({
                success: false,
                error: `رصيدك الحالي (${currentBalance} دج) غير كافٍ لترقية الحساب. المبلغ المطلوب هو 700 دج.`,
                needed: VIP_COST - currentBalance
            });
        }

        const newBalance = currentBalance - VIP_COST;
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const currentVerifyStatus = teacher.verification_status || 'unverified';
        const nextStatus = (currentVerifyStatus === 'approved') ? 'approved' : 'pending_docs';

        const { data: updateRes, error: updateErr } = await supabase.from('teachers').update({
            balance: newBalance,
            is_vip: true,
            is_certified: nextStatus === 'approved',
            vip_expires_at: expiresAt,
            verification_status: nextStatus,
            updated_at: new Date().toISOString()
        }).eq('id', teacherId).eq('balance', teacher.balance).select();

        if (updateErr || !updateRes || updateRes.length === 0) {
            return res.status(409).json({ success: false, error: 'حدث تغيير في الرصيد أثناء المعالجة، يرجى المحاولة مرة أخرى' });
        }

        await insert('wallet_transactions', {
            teacher_id: teacherId,
            amount: VIP_COST,
            type: 'withdraw',
            status: 'completed',
            description: 'خصم 700 دج مقابل ترقية الحساب للشارة الذهبية (VIP) لمدة 30 يوماً',
            created_at: new Date().toISOString()
        });

        try {
            await supabase.from('teacher_vip_subscriptions').insert({
                teacher_id: teacherId,
                amount: VIP_COST,
                duration_days: 30,
                status: 'active',
                expires_at: expiresAt,
                created_at: new Date().toISOString()
            });
        } catch (subErr) {}

        await supabase.from('notifications').insert({
            user_id: teacherId,
            user_type: 'teacher',
            title: '⭐ تم ترقية حسابك إلى VIP والشارة الذهبية',
            message: 'تم خصم 700 دج من رصيدك بنجاح. يرجى رفع الوثائق المطلوبة (بطاقة الهوية والدبلوم) لتكتمل الترقية وتفعيل شارتك الذهبية وميزات الكبار!',
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: '🎉 تم خصم 700 دج لترقية حسابك بنجاح! يرجى رفع وثائق التوثيق (بطاقة الهوية والدبلوم) لراجعتها واعتماد الشارة الذهبية بالكامل.',
            vip_expires_at: expiresAt,
            new_balance: newBalance,
            verification_status: nextStatus
        });
    } catch (error) {
        logger.error('خطأ في ترقية حساب الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في عملية الترقية' });
    }
});

// ============================================================
// 📄 رفع وثائق التوثيق (بطاقة الهوية والدبلوم)
// ============================================================
router.post('/teacher/upload-verification-docs', authenticate, authorize(['teacher']), upload.fields([
    { name: 'id_card', maxCount: 1 },
    { name: 'diploma', maxCount: 1 }
]), async (req, res) => {
    try {
        const teacherId = req.user.userId;
        const teacher = await getOne('teachers', 'id', teacherId);

        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        if (!teacher.is_vip) {
            return res.status(403).json({ success: false, error: 'يرجى ترقية حسابك إلى VIP أولاً قبل رفع وثائق التوثيق.' });
        }

        let idCardUrl = teacher.id_card_image || teacher.id_card_image_url || null;
        let diplomaUrl = teacher.diploma_image || teacher.certificate_image_url || null;

        if (req.files) {
            if (req.files.id_card && req.files.id_card[0]) {
                const file = req.files.id_card[0];
                const uploadRes = await uploadToSupabase(file.buffer, file.originalname, 'verifications', 'id_cards');
                if (uploadRes.success) idCardUrl = uploadRes.publicUrl;
            }
            if (req.files.diploma && req.files.diploma[0]) {
                const file = req.files.diploma[0];
                const uploadRes = await uploadToSupabase(file.buffer, file.originalname, 'verifications', 'diplomas');
                if (uploadRes.success) diplomaUrl = uploadRes.publicUrl;
            }
        }

        if (!idCardUrl && req.body.id_card_url) idCardUrl = req.body.id_card_url;
        if (!diplomaUrl && req.body.diploma_url) diplomaUrl = req.body.diploma_url;

        if (!idCardUrl || !diplomaUrl) {
            return res.status(400).json({
                success: false,
                error: 'يرجى إرفاق بطاقة الهوية والشهادة/الدبلوم معاً لإتمام طلب التوثيق'
            });
        }

        await update('teachers', teacherId, {
            id_card_image: idCardUrl,
            diploma_image: diplomaUrl,
            verification_status: 'under_review',
            updated_at: new Date().toISOString()
        });

        try {
            await supabase.from('teacher_verification_requests').insert({
                teacher_id: teacherId,
                id_card_url: idCardUrl,
                diploma_url: diplomaUrl,
                status: 'pending',
                created_at: new Date().toISOString()
            });
        } catch (reqErr) {}

        await supabase.from('notifications').insert({
            user_id: teacherId,
            user_type: 'teacher',
            title: '📄 تم استلام وثائق التوثيق',
            message: 'تم رفع وثائقك بنجاح وسيقوم فريق المنصة بمراجعتها واعتماد حسابك بالشارة الذهبية في أقرب وقت.',
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: '✅ تم رفع وثائق التوثيق بنجاح! وهي الآن قيد المراجعة والتحقق من طرف الإدارة.',
            verification_status: 'under_review'
        });
    } catch (error) {
        logger.error('خطأ في رفع وثائق التوثيق:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في رفع الوثائق' });
    }
});

// ============================================================
// 🚀 طلب ترويج وتواصل مباشر مع مؤسس المنصة (خا�� بأساتذة VIP)
// ============================================================
router.post('/teacher/request-founder-promo', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacherId = req.user.userId;
        const { message } = req.body;
        const teacher = await getOne('teachers', 'id', teacherId);

        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        if (!teacher.is_vip && !teacher.is_certified) {
            return res.status(403).json({
                success: false,
                error: 'هذه الميزة مخصصة فقط لأساتذة VIP الحاصلين على الشارة الذهبية.'
            });
        }

        await update('teachers', teacherId, {
            founder_promo_requested: true,
            founder_promo_message: message || 'طلب ترويج وتواصل مباشر مع المؤسس',
            updated_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: '🚀 تم إرسال طلب الترويج والتواصل المباشر إلى مؤسس المنصة بنجاح! سيتم التواصل معك قريباً وترويج حسابك.',
            whatsapp_founder: '+213550000000'
        });
    } catch (error) {
        logger.error('خطأ في طلب ترويج المؤسس:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء إرسال الطلب' });
    }
});

module.exports = router;
