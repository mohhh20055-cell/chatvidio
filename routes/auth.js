// ============================================================
// مسارات المصادقة - Auth Routes (معدل بالكامل مع دعم نظام البث)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');

const { supabase } = require('../config/database');
const { authenticate, authorize, checkBanned } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { getOne, insert, update, generateVerificationToken, generateReferralCode, sanitizeObject } = require('../utils/helpers');
const { encrypt, maskIP } = require('../utils/encryption');
const { sendVerificationEmail, sendResetEmail, sendTeacherApprovalEmail, sendTeacherRejectionEmail } = require('../utils/email');
const { processReferralOnRegister } = require('../utils/referral');
const { uploadToSupabase, validateUploadedFiles } = require('../utils/upload');
const { verifyRecaptcha } = require('../utils/validation');
const { generateToken, verifyToken } = require('../utils/jwt');
const logger = require('../utils/logger');

// ============================================================
// الثوابت
// ============================================================
const SALT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@platform.com';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('admin123', 12);

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
// نظام تتبع محاولات تسجيل الدخول الفاشلة
// ============================================================
const loginAttempts = new Map();

function trackLoginAttempt(email) {
    const now = Date.now();
    if (!loginAttempts.has(email)) {
        loginAttempts.set(email, { count: 1, firstAttempt: now, lastAttempt: now });
        return { count: 1, locked: false };
    }

    const record = loginAttempts.get(email);
    
    if (now - record.firstAttempt > LOCKOUT_TIME) {
        loginAttempts.set(email, { count: 1, firstAttempt: now, lastAttempt: now });
        return { count: 1, locked: false };
    }

    record.count++;
    record.lastAttempt = now;
    loginAttempts.set(email, record);

    const locked = record.count >= MAX_LOGIN_ATTEMPTS;
    return { count: record.count, locked };
}

function resetLoginAttempts(email) {
    loginAttempts.delete(email);
}

// ============================================================
// نظام رموز إعادة تعيين كلمة المرور
// ============================================================
const passwordResetTokens = new Map();
let passwordResetsUseMemory = false;

async function storePasswordReset(email, role, token, expiresAt) {
    if (!passwordResetsUseMemory) {
        try {
            await insert('password_resets', {
                email: email.trim().toLowerCase(),
                role: role,
                token: token,
                expires_at: expiresAt.toISOString(),
                used: false,
                created_at: new Date().toISOString()
            });
            return true;
        } catch (error) {
            if (error.message && error.message.includes('password_resets')) {
                console.warn('⚠️ جدول password_resets غير موجود، سيتم استخدام الذاكرة المؤقتة');
            } else {
                console.error('⚠️ فشل حفظ رمز إعادة التعيين في قاعدة البيانات:', error.message);
            }
            passwordResetsUseMemory = true;
        }
    }

    passwordResetTokens.set(token, {
        email: email.trim().toLowerCase(),
        role: role,
        expires_at: expiresAt.toISOString(),
        used: false
    });
    return true;
}

async function getPasswordReset(token) {
    if (!passwordResetsUseMemory) {
        try {
            const reset = await getOne('password_resets', 'token', token);
            if (reset) return reset;
        } catch (error) {
            passwordResetsUseMemory = true;
        }
    }

    const memoryReset = passwordResetTokens.get(token) || null;
    return memoryReset;
}

async function markPasswordResetUsed(token) {
    if (!passwordResetsUseMemory) {
        try {
            const reset = await getOne('password_resets', 'token', token);
            if (reset) {
                await update('password_resets', reset.id, {
                    used: true,
                    used_at: new Date().toISOString()
                });
            }
            return;
        } catch (error) {
            passwordResetsUseMemory = true;
        }
    }

    const memoryReset = passwordResetTokens.get(token);
    if (memoryReset) {
        memoryReset.used = true;
        passwordResetTokens.set(token, memoryReset);
    }
}

// ============================================================
// ✅ تسجيل أستاذ جديد (مع المستوى التعليمي)
// ============================================================
router.post('/teacher/register', checkBanned, upload.fields([
    { name: 'profile_image', maxCount: 1 },
    { name: 'diploma_image', maxCount: 1 },
    { name: 'id_image', maxCount: 1 }
]), validateUploadedFiles, [
    body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب').isLength({ max: 100 }),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('كلمة المرور يجب أن تحتوي على حرف كبير وحرف صغير ورقم'),
    body('phone').notEmpty().withMessage('رقم الهاتف مطلوب'),
    body('specialization').notEmpty().withMessage('التخصص مطلوب').isLength({ max: 100 }),
    body('bio').notEmpty().withMessage('نبذة عنك مطلوبة').isLength({ max: 500 }),
    body('experience').notEmpty().withMessage('سنوات الخبرة مطلوبة'),
    body('teaching_level').notEmpty().withMessage('المستوى الدراسي مطلوب'),
    body('recaptcha_token').notEmpty().withMessage('رمز reCAPTCHA مطلوب')
], async (req, res) => {
    try {
        // ✅ 1. التحقق من صحة البيانات
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            const errorMessages = errors.array().map(e => e.msg).join('، ');
            return res.status(400).json({ 
                success: false, 
                error: errorMessages,
                errors: errors.array() 
            });
        }

        const { full_name, email, password, phone, specialization, bio, experience, teaching_level, recaptcha_token, ref } = req.body;

        console.log(`📥 تسجيل أستاذ جديد: ${full_name}, المستوى: ${teaching_level}`);

        // ✅ 2. التحقق من reCAPTCHA
        const recaptchaResult = await verifyRecaptcha(recaptcha_token);
        if (!recaptchaResult.success) {
            return res.status(400).json({ 
                success: false, 
                error: recaptchaResult.error || 'فشل التحقق من reCAPTCHA، يرجى المحاولة مرة أخرى' 
            });
        }

        // ✅ 3. التحقق من وجود البريد
        const existingTeacher = await getOne('teachers', 'email', email);
        if (existingTeacher) {
            return res.status(400).json({ 
                success: false, 
                error: '⚠️ البريد الإلكتروني مستخدم مسبقاً. يرجى استخدام بريد إلكتروني آخر.' 
            });
        }

        // ✅ 4. التحقق من وجود البريد في جدول الطلاب أيضاً (لا يمكن استخدام نفس البريد)
        const existingStudent = await getOne('students', 'email', email);
        if (existingStudent) {
            return res.status(400).json({ 
                success: false, 
                error: '⚠️ هذا البريد الإلكتروني مستخدم كطالب. يرجى استخدام بريد إلكتروني آخر.' 
            });
        }

        // ✅ 5. تشفير كلمة المرور
        const hashedPassword = bcrypt.hashSync(password, SALT_ROUNDS);
        
        // ✅ 6. رفع الملفات
        let profile_image = null;
        let profile_url = null;
        let diploma_image = null;
        let id_image = null;

        if (req.files && req.files['profile_image'] && req.files['profile_image'][0]) {
            const uploaded = await uploadToSupabase(req.files['profile_image'][0], 'teachers');
            if (uploaded) {
                profile_image = uploaded.filename;
                profile_url = uploaded.url;
            }
        }

        if (req.files && req.files['diploma_image'] && req.files['diploma_image'][0]) {
            const uploaded = await uploadToSupabase(req.files['diploma_image'][0], 'diplomas');
            if (uploaded) diploma_image = uploaded.filename;
        }

        if (req.files && req.files['id_image'] && req.files['id_image'][0]) {
            const uploaded = await uploadToSupabase(req.files['id_image'][0], 'ids');
            if (uploaded) id_image = uploaded.filename;
        }

        // ✅ 7. إنشاء الأستاذ في قاعدة البيانات (حالة pending)
        const newTeacher = await insert('teachers', {
            full_name: full_name.trim(),
            email: email.trim().toLowerCase(),
            password: hashedPassword,
            phone: phone.trim(),
            specialization: specialization.trim(),
            bio: bio.trim(),
            experience: experience.trim(),
            teaching_level: teaching_level.trim(),
            profile_image,
            profile_url,
            diploma_image,
            id_image,
            status: 'pending', // ✅ في انتظار المراجعة
            email_verified: false,
            balance: 0,
            referral_balance: 0,
            total_earned: 0,
            total_withdrawn: 0,
            pending_withdraw: 0,
            referral_code: null,
            is_banned: false,
            ban_reason: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        // ✅ 8. إنشاء رمز الإحالة
        const referralCode = generateReferralCode(full_name, newTeacher.id);
        await supabase
            .from('teachers')
            .update({ referral_code: referralCode })
            .eq('id', newTeacher.id);

        // ✅ 9. معالجة الإحالة إذا وجدت
        if (ref && ref.length > 3) {
            await processReferralOnRegister(ref, newTeacher.id, 'teacher');
        }

        // ✅ 10. إرسال إشعار للمدير
        try {
            await insert('notifications', {
                user_id: 1, // Admin ID
                user_type: 'admin',
                title: '📝 طلب تسجيل أستاذ جديد',
                message: `قام الأستاذ ${full_name} بتقديم طلب تسجيل. يرجى مراجعة الطلب.`,
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (notifError) {
            console.error('⚠️ خطأ في إرسال إشعار للمدير:', notifError.message);
        }

        // ✅ 11. الرد بنجاح - لا يتم إرسال بريد تحقق للأستاذ
        res.json({ 
            success: true, 
            message: '✅ تم تسجيل حسابك بنجاح! سيتم مراجعة طلبك من قبل الإدارة. سيتم إعلامك عبر البريد الإلكتروني عند قبول حسابك.',
            teacher_id: newTeacher.id,
            email: email,
            role: 'teacher',
            teaching_level: teaching_level,
            referral_code: referralCode,
            status: 'pending'
        });

    } catch (error) {
        console.error('❌ خطأ في تسجيل أستاذ:', error.message);
        console.error('📚 Stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ أثناء التسجيل. يرجى المحاولة مرة أخرى.' 
        });
    }
});

// ============================================================
// ✅ تسجيل طالب جديد (مع المستوى التعليمي)
// ============================================================
router.post('/student/register', checkBanned, [
    body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب').isLength({ max: 100 }),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('كلمة المرور يجب أن تحتوي على حرف كبير وحرف صغير ورقم'),
    body('phone').notEmpty().withMessage('رقم الهاتف مطلوب'),
    body('education_level').notEmpty().withMessage('المستوى الدراسي مطلوب'),
    body('recaptcha_token').notEmpty().withMessage('رمز reCAPTCHA مطلوب')
], async (req, res) => {
    try {
        // ✅ 1. التحقق من صحة البيانات
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            const errorMessages = errors.array().map(e => e.msg).join('، ');
            return res.status(400).json({ 
                success: false, 
                error: errorMessages,
                errors: errors.array() 
            });
        }

        const { full_name, email, password, phone, education_level, recaptcha_token, ref } = req.body;

        console.log(`📥 تسجيل طالب جديد: ${full_name}, المستوى: ${education_level}`);

        // ✅ 2. التحقق من reCAPTCHA
        const recaptchaResult = await verifyRecaptcha(recaptcha_token);
        if (!recaptchaResult.success) {
            return res.status(400).json({ 
                success: false, 
                error: recaptchaResult.error || 'فشل التحقق من reCAPTCHA، يرجى المحاولة مرة أخرى' 
            });
        }

        // ✅ 3. التحقق من وجود البريد في جدول الطلاب
        const existingStudent = await getOne('students', 'email', email);
        if (existingStudent) {
            return res.status(400).json({ 
                success: false, 
                error: '⚠️ البريد الإلكتروني مستخدم مسبقاً. يرجى استخدام بريد إلكتروني آخر.' 
            });
        }

        // ✅ 4. التحقق من وجود البريد في جدول الأساتذة أيضاً
        const existingTeacher = await getOne('teachers', 'email', email);
        if (existingTeacher) {
            return res.status(400).json({ 
                success: false, 
                error: '⚠️ هذا البريد الإلكتروني مستخدم كأستاذ. يرجى استخدام بريد إلكتروني آخر.' 
            });
        }

        // ✅ 5. تشفير كلمة المرور
        const hashedPassword = bcrypt.hashSync(password, SALT_ROUNDS);
        
        // ✅ 6. إنشاء الطالب في قاعدة البيانات
        const newStudent = await insert('students', {
            full_name: full_name.trim(),
            email: email.trim().toLowerCase(),
            password: hashedPassword,
            phone: phone.trim(),
            education_level: education_level.trim(),
            wallet_balance: 0,
            email_verified: true, // ✅ الطالب مؤكد تلقائياً
            referral_balance: 0,
            gift_box_chances: 0,
            referral_code: null,
            is_banned: false,
            ban_reason: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        // ✅ 7. إنشاء رمز الإحالة
        const referralCode = generateReferralCode(full_name, newStudent.id);
        await supabase
            .from('students')
            .update({ referral_code: referralCode })
            .eq('id', newStudent.id);

        // ✅ 8. معالجة الإحالة إذا وجدت
        if (ref && ref.length > 3) {
            await processReferralOnRegister(ref, newStudent.id, 'student');
        }

        // ✅ 9. إنشاء توكن للطالب (تسجيل الدخول التلقائي)
        const token = generateToken(newStudent.id, 'student', email);

        // ✅ 10. إرسال إشعار ترحيب
        try {
            await insert('notifications', {
                user_id: newStudent.id,
                user_type: 'student',
                title: '🎉 مرحباً بك في ZoomDz!',
                message: `مرحباً ${full_name}! نتمنى لك تجربة تعليمية ممتعة. يمكنك البدء بحجز الدروس من قسم "العروض".`,
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (notifError) {
            console.error('⚠️ خطأ في إرسال إشعار الترحيب:', notifError.message);
        }

        // ✅ 11. الرد بنجاح - لا يتم إرسال بريد تحقق للطالب
        res.json({ 
            success: true, 
            message: '✅ تم تسجيل حسابك بنجاح! يمكنك الآن تسجيل الدخول والبدء في التعلم.',
            student_id: newStudent.id,
            email: email,
            role: 'student',
            education_level: education_level,
            referral_code: referralCode,
            token: token, // ✅ توكن لتسجيل الدخول التلقائي
            redirectTo: '/student-dashboard.html'
        });

    } catch (error) {
        console.error('❌ خطأ في تسجيل طالب:', error.message);
        console.error('📚 Stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ أثناء التسجيل. يرجى المحاولة مرة أخرى.' 
        });
    }
});

// ============================================================
// ✅ تسجيل الدخول (مع رسائل خطأ محسنة ودعم حالة البث)
// ============================================================
router.post('/login', checkBanned, authLimiter, [
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('password').notEmpty().withMessage('كلمة المرور مطلوبة'),
    body('role').isIn(['student', 'teacher', 'admin']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            const errorMessages = errors.array().map(e => e.msg).join('، ');
            return res.status(400).json({ 
                success: false, 
                error: errorMessages 
            });
        }

        const { email, password, role } = req.body;

        // ✅ تسجيل دخول المدير
        if (role === 'admin') {
            if (email !== ADMIN_EMAIL) {
                return res.status(401).json({ success: false, error: '❌ بيانات الدخول غير صحيحة' });
            }
            
            const isValid = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
            if (!isValid) {
                return res.status(401).json({ success: false, error: '❌ بيانات الدخول غير صحيحة' });
            }
            
            const token = generateToken(0, 'admin', email);
            
            return res.json({
                success: true,
                token: token,
                redirectTo: '/admin.html',
                user: { 
                    id: 0, 
                    name: 'مدير المنصة', 
                    role: 'admin',
                    email: ADMIN_EMAIL
                }
            });
        }

        // ✅ تتبع محاولات تسجيل الدخول
        const attempt = trackLoginAttempt(email);
        if (attempt.locked) {
            return res.status(429).json({
                success: false,
                error: `⛔ تم تجاوز عدد المحاولات المسموح بها. يرجى المحاولة بعد ${Math.ceil(LOCKOUT_TIME / 60000)} دقائق`
            });
        }

        let user = null;
        let userRole = 'teacher';

        logger.info('محاولة تسجيل دخول', { email, role });

        if (role === 'teacher') {
            user = await getOne('teachers', 'email', email);
            userRole = 'teacher';
        } else if (role === 'student') {
            user = await getOne('students', 'email', email);
            userRole = 'student';
        }

        logger.info('نتيجة جلب المستخدم', { 
            email, 
            role, 
            userFound: !!user, 
            userId: user?.id 
        });

        // ✅ التحقق من وجود المستخدم
        if (!user) {
            trackLoginAttempt(email);
            logger.warn('تسجيل دخول فاشل - مستخدم غير موجود', { email, role });
            return res.status(404).json({ 
                success: false, 
                error: '❌ البريد الإلكتروني غير موجود. يرجى التحقق من البريد أو التسجيل أولاً.' 
            });
        }

        // ✅ التحقق من الحظر
        if (user.is_banned === true) {
            return res.status(403).json({
                success: false,
                error: `⛔ تم حظر حسابك من المنصة. السبب: ${user.ban_reason || 'انتهاك شروط الاستخدام'}`,
                banned: true,
                reason: user.ban_reason || 'انتهاك شروط الاستخدام'
            });
        }

        // ✅ التحقق من كلمة المرور
        const validPassword = bcrypt.compareSync(password, user.password);
        if (!validPassword) {
            trackLoginAttempt(email);
            return res.status(401).json({ 
                success: false, 
                error: '❌ كلمة المرور خاطئة. يرجى المحاولة مرة أخرى.' 
            });
        }

        resetLoginAttempts(email);

        // ✅ التحقق من حالة الأستاذ (pending / approved / rejected)
        if (userRole === 'teacher') {
            if (user.status === 'pending') {
                return res.status(403).json({ 
                    success: false, 
                    error: '⏳ حسابك قيد المراجعة من قبل الإدارة. سيتم إعلامك عند قبول حسابك.',
                    pending_approval: true
                });
            }
            if (user.status === 'rejected') {
                return res.status(403).json({ 
                    success: false, 
                    error: `❌ تم رفض طلبك. السبب: ${user.rejection_reason || 'لم يتم تحديد سبب'}`,
                    rejected: true
                });
            }
            if (user.status !== 'approved') {
                return res.status(403).json({ 
                    success: false, 
                    error: '❌ حسابك غير مفعل. يرجى التواصل مع الإدارة.',
                    status: user.status
                });
            }
        }

        // ✅ التحقق من البريد الإلكتروني للطلاب (اختياري)
        if (userRole === 'student' && !user.email_verified) {
            // يمكن تفعيل هذا إذا أردت التأكد من البريد للطلاب
            // لكن حالياً الطلاب مؤكدون تلقائياً
        }

        // ✅ تسجيل سجل الدخول
        let ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
        if (ip && typeof ip === 'string' && ip.includes(',')) {
            ip = ip.split(',')[0].trim();
        }
        if (ip && typeof ip === 'string') {
            ip = ip.replace(/:\d+[^:]*$/, '');
        }

        if (ip) {
            try {
                const encryptedIP = encrypt(ip);
                await insert('login_logs', {
                    user_id: user.id,
                    user_role: userRole,
                    ip_address_encrypted: encryptedIP,
                    ip_address_masked: maskIP(ip),
                    created_at: new Date().toISOString()
                });
            } catch (logError) {
                console.error('خطأ في تسجيل سجل الدخول:', logError.message);
            }
        }

        // ✅ التحقق من وجود بث نشط للأستاذ
        let hasActiveStream = false;
        if (userRole === 'teacher') {
            const { data: activeOffer } = await supabase
                .from('offers')
                .select('id, status')
                .eq('teacher_id', user.id)
                .in('status', ['live', 'teacher_ready', 'paused'])
                .single();

            hasActiveStream = !!activeOffer;
        }

        // ✅ إنشاء التوكن
        const token = generateToken(user.id, userRole, email);
        const redirectPath = userRole === 'teacher' ? '/teacher-dashboard.html' : '/student-dashboard.html';
        
        // ✅ بيانات المستخدم المرجعة
        const userData = {
            id: user.id,
            name: user.full_name,
            role: userRole,
            profile_image: user.profile_image,
            profile_url: user.profile_url,
            balance: user.wallet_balance || user.balance || 0,
            email_verified: user.email_verified,
            referral_code: user.referral_code,
            education_level: user.education_level || null,
            teaching_level: user.teaching_level || null,
            status: user.status || null,
            has_active_stream: hasActiveStream // ✅ إعلام العميل بوجود بث نشط
        };
        
        logger.info('تسجيل دخول ناجح', {
            userId: user.id,
            role: userRole,
            email: email
        });
        
        res.json({
            success: true,
            token: token,
            redirectTo: redirectPath,
            user: userData
        });

    } catch (error) {
        logger.error('خطأ في تسجيل الدخول', {
            email: email,
            role: role,
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم. يرجى المحاولة مرة أخرى.' 
        });
    }
});

// ============================================================
// ✅ تسجيل الخروج
// ============================================================
router.post('/logout', authenticate, (req, res) => {
    res.json({ success: true, message: '✅ تم تسجيل الخروج بنجاح' });
});

// ============================================================
// ✅ إعادة إرسال رابط التأكيد (للطلاب فقط - اختياري)
// ============================================================
router.post('/resend-verification', authLimiter, [
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح'),
    body('recaptcha_token').notEmpty().withMessage('رمز reCAPTCHA مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { email, role, recaptcha_token } = req.body;

        const recaptchaResult = await verifyRecaptcha(recaptcha_token);
        if (!recaptchaResult.success) {
            return res.status(400).json({ success: false, error: recaptchaResult.error });
        }

        let user = null;
        if (role === 'student') {
            user = await getOne('students', 'email', email);
        } else if (role === 'teacher') {
            user = await getOne('teachers', 'email', email);
        }

        if (!user) {
            return res.status(404).json({ success: false, error: 'لا يوجد حساب بهذا البريد الإلكتروني' });
        }

        if (user.email_verified === true) {
            return res.status(400).json({ success: false, error: 'الحساب مؤكد بالفعل' });
        }

        const verificationToken = generateVerificationToken();
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        await insert('email_verifications', {
            email: email,
            role: role,
            token: verificationToken,
            expires_at: expiresAt.toISOString(),
            used: false,
            created_at: new Date().toISOString()
        });

        const baseUrl = process.env.PLATFORM_URL ||
                        (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
        const verificationUrl = `${baseUrl}/api/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}&role=${role}`;

        const emailSent = await sendVerificationEmail(email, user.full_name, verificationUrl);

        if (emailSent) {
            res.json({ success: true, message: '✅ تم إرسال رابط تأكيد الحساب إلى بريدك الإلكتروني' });
        } else {
            res.json({
                success: true,
                message: `⚠️ لم نتمكن من إرسال البريد. الرابط الخاص بك: ${verificationUrl}`,
                showDirectLink: true,
                verificationUrl: verificationUrl
            });
        }
    } catch (error) {
        console.error('خطأ في إعادة إرسال التأكيد:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ تأكيد البريد الإلكتروني (للطلاب فقط)
// ============================================================
router.get('/verify-email', async (req, res) => {
    try {
        const { token, email, role } = req.query;

        if (!token || !email || !role) {
            return res.status(400).send('❌ رابط التحقق غير صالح');
        }

        if (!['student', 'teacher'].includes(role)) {
            return res.status(400).send('❌ دور غير صالح');
        }

        const record = await getOne('email_verifications', 'token', token);

        if (!record || record.email !== email || record.role !== role || record.used || new Date(record.expires_at) < new Date()) {
            return res.status(400).send('❌ رابط التحقق غير صالح أو منتهي الصلاحية');
        }

        const table = role === 'student' ? 'students' : 'teachers';
        const user = await getOne(table, 'email', email);

        if (user) {
            await update(table, user.id, {
                email_verified: true,
                updated_at: new Date().toISOString()
            });
        }

        await update('email_verifications', record.id, {
            used: true,
            verified_at: new Date().toISOString()
        });

        res.send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head>
                <meta charset="UTF-8">
                <title>✅ تم تأكيد البريد</title>
                <script>setTimeout(() => window.location.href = '/?verified=1', 3000);</script>
                <style>
                    body { font-family: 'Cairo', sans-serif; text-align: center; padding: 40px; background: #f0f4ff; }
                    .card { background: white; border-radius: 20px; padding: 40px; max-width: 500px; margin: auto; box-shadow: 0 10px 40px rgba(0,0,0,0.1); }
                    h1 { color: #10b981; }
                    .btn { display: inline-block; background: #0f5cbf; color: white; padding: 12px 30px; border-radius: 50px; text-decoration: none; font-weight: 700; margin-top: 20px; }
                    .btn:hover { background: #0b4a9c; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>✅ تم تأكيد بريدك الإلكتروني بنجاح!</h1>
                    <p>يمكنك الآن تسجيل الدخول إلى حسابك.</p>
                    <a href="/" class="btn">🚀 الذهاب إلى المنصة</a>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('خطأ في تأكيد البريد:', error.message);
        res.status(500).send('❌ حدث خطأ في الخادم');
    }
});

// ============================================================
// ✅ طلب إعادة تعيين كلمة المرور
// ============================================================
router.post('/forgot-password', [
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { email, role } = req.body;

        const table = role === 'student' ? 'students' : 'teachers';
        const user = await getOne(table, 'email', email);

        if (!user) {
            return res.status(404).json({ 
                success: false, 
                error: '❌ لا يوجد حساب بهذا البريد الإلكتروني' 
            });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 1);

        await storePasswordReset(email, role, token, expiresAt);

        const baseUrl = process.env.PLATFORM_URL ||
                        (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
        const resetUrl = `${baseUrl}/reset-password.html?token=${token}&email=${encodeURIComponent(email)}&role=${role}`;

        const emailSent = await sendResetEmail(email, user.full_name, resetUrl);

        if (emailSent) {
            res.json({ 
                success: true, 
                message: '✅ تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك الإلكتروني' 
            });
        } else {
            res.json({
                success: true,
                message: `⚠️ لم نتمكن من إرسال البريد. الرابط الخاص بك: ${resetUrl}`,
                showDirectLink: true,
                resetUrl: resetUrl
            });
        }
    } catch (error) {
        console.error('خطأ في طلب إعادة التعيين:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ التحقق من رمز إعادة التعيين
// ============================================================
router.post('/verify-reset-token', [
    body('token').notEmpty().withMessage('الرمز مطلوب'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { token, email, role } = req.body;
        const reset = await getPasswordReset(token);

        if (!reset ||
            reset.email !== email.trim().toLowerCase() ||
            reset.role !== role ||
            reset.used ||
            new Date(reset.expires_at) < new Date()) {
            return res.status(400).json({ 
                success: false, 
                error: '❌ رابط إعادة التعيين غير صالح أو منتهي الصلاحية' 
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في التحقق من رمز إعادة التعيين:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إعادة تعيين كلمة المرور
// ============================================================
router.post('/reset-password', [
    body('token').notEmpty().withMessage('الرمز مطلوب'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح'),
    body('new_password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { token, email, role, new_password } = req.body;
        const reset = await getPasswordReset(token);

        if (!reset ||
            reset.email !== email.trim().toLowerCase() ||
            reset.role !== role ||
            reset.used ||
            new Date(reset.expires_at) < new Date()) {
            return res.status(400).json({ 
                success: false, 
                error: '❌ رابط إعادة التعيين غير صالح أو منتهي الصلاحية' 
            });
        }

        const table = role === 'student' ? 'students' : 'teachers';
        const user = await getOne(table, 'email', email);

        if (!user) {
            return res.status(404).json({ success: false, error: '❌ المستخدم غير موجود' });
        }

        const hashedPassword = bcrypt.hashSync(new_password, SALT_ROUNDS);
        await update(table, user.id, {
            password: hashedPassword,
            updated_at: new Date().toISOString()
        });

        await markPasswordResetUsed(token);

        res.json({ 
            success: true, 
            message: '✅ تم تغيير كلمة المرور بنجاح' 
        });
    } catch (error) {
        console.error('خطأ في إعادة تعيين كلمة المرور:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ الحصول على معلومات المستخدم الحالي (مع حالة البث)
// ============================================================
router.get('/me', authenticate, async (req, res) => {
    try {
        const userId = req.user.userId;
        const role = req.user.role;

        let user = null;
        let table = role === 'student' ? 'students' : 'teachers';
        
        user = await getOne(table, 'id', userId);
        
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }

        // ✅ التحقق من وجود بث نشط للأستاذ
        let hasActiveStream = false;
        let activeOffer = null;
        if (role === 'teacher') {
            const { data: offer } = await supabase
                .from('offers')
                .select('id, status, subject_name, stream_url, duration')
                .eq('teacher_id', userId)
                .in('status', ['live', 'teacher_ready', 'paused'])
                .single();

            if (offer) {
                hasActiveStream = true;
                activeOffer = offer;
            }
        }

        delete user.password;

        res.json({
            success: true,
            user: {
                ...user,
                has_active_stream: hasActiveStream,
                active_offer: activeOffer
            }
        });
    } catch (error) {
        console.error('خطأ في جلب معلومات المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
