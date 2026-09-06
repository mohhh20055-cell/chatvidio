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
const { getOne, insert, update, generateVerificationToken, generateReferralCode, sanitizeObject, isNameTaken } = require('../utils/helpers');
const { encrypt, maskIP } = require('../utils/encryption');
const { sendVerificationEmail, sendResetEmail, sendTeacherApprovalEmail, sendTeacherRejectionEmail } = require('../utils/email');
const { processReferralOnRegister } = require('../utils/referral');
const { uploadToSupabase, validateUploadedFiles } = require('../utils/upload');
const { verifyRecaptcha, isValidDzPhone, isValidEmail } = require('../utils/validation');
const { generateToken, verifyToken } = require('../utils/jwt');
const { getPublicImageUrl, processUserProfile } = require('../utils/upload');
const logger = require('../utils/logger');

const { ADMIN_EMAIL, ADMIN_PASSWORD_HASH, verifyAdminCredentials } = require('../utils/adminConfig');

// ============================================================
// الثوابت
// ============================================================
const SALT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000;

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];
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
                logger.error('⚠️ فشل حفظ رمز إعادة التعيين في قاعدة البيانات:', error.message);
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
// ✅ تسجيل أستاذ جديد - الخطوة الأولى (الاسم والبريد ورقم الهاتف وكلمة المرور)
// ============================================================
router.post('/teacher/register', checkBanned, [
    body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب').isLength({ max: 100 }),
    body('email').notEmpty().withMessage('البريد الإلكتروني مطلوب').trim().custom((val) => {
        if (!isValidEmail(val)) {
            throw new Error('⚠️ صيغة البريد الإلكتروني غير صحيحة (مثال: example@gmail.com)');
        }
        return true;
    }),
    body('phone').notEmpty().withMessage('رقم الهاتف مطلوب').trim().custom((val) => {
        if (!isValidDzPhone(val)) {
            throw new Error('⚠️ رقم الهاتف يجب أن يكون برقم جزائري صحيح (مثال: 0550123456 أو 0660123456 أو 0770123456)');
        }
        return true;
    }),
    body('password').notEmpty().withMessage('كلمة المرور مطلوبة')
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

        console.log(`📥 بدء تسجيل أستاذ جديد: ${full_name}`);

        // ✅ 2. التحقق من reCAPTCHA
        const recaptchaResult = await verifyRecaptcha(recaptcha_token);
        if (!recaptchaResult.success) {
            return res.status(400).json({
                success: false,
                error: recaptchaResult.error || 'فشل التحقق من reCAPTCHA، يرجى المحاولة مرة أخرى'
            });
        }

        // ✅ 3. التحقق من فرادة الاسم وعدم تكراره في المنصة (أساتذة وطلاب)
        const nameCheck = await isNameTaken(full_name);
        if (nameCheck.taken) {
            return res.status(400).json({
                success: false,
                error: '⚠️ هذا الاسم الكامل مستخدم مسبقاً في المنصة. يرجى اختيار اسم فريد لتمييز حسابك.'
            });
        }

        // ✅ 4. التحقق من وجود البريد
        const existingTeacher = await getOne('teachers', 'email', email);
        if (existingTeacher) {
            return res.status(400).json({
                success: false,
                error: '⚠️ البريد الإلكتروني مستخدم مسبقاً. يرجى استخدام بريد إلكتروني آخر.'
            });
        }

        // ✅ 5. التحقق من وجود البريد في جدول الطلاب أيضاً
        const existingStudent = await getOne('students', 'email', email);
        if (existingStudent) {
            return res.status(400).json({
                success: false,
                error: '⚠️ هذا البريد الإلكتروني مستخدم كطالب. يرجى استخدام بريد إلكتروني آخر.'
            });
        }

        // ✅ 6. تشفير كلمة المرور
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        // ✅ 7. إنشاء الأستاذ في قاعدة البيانات (حساب مفعل وموثق تلقائياً)
        const newTeacher = await insert('teachers', {
            full_name: full_name.trim(),
            email: email.trim().toLowerCase(),
            password: hashedPassword,
            phone: phone ? phone.trim() : null,
            specialization: specialization ? specialization.trim() : null,
            bio: bio ? bio.trim() : null,
            experience: experience ? experience.trim() : null,
            teaching_level: teaching_level ? teaching_level.trim() : null,
            profile_image: null,
            diploma_image: null,
            id_image: null,
            status: 'approved',
            is_certified: false,
            email_verified: true, // ✅ لا حاجة لتأكيد البريد للأستاذ
            balance: 0,
            referral_balance: 0,
            total_earned: 0,
            total_withdrawn: 0,
            pending_withdraw: 0,
            referral_code: null,
            is_banned: false,
            ban_reason: null,
            profile_completion: true, // ✅ حساب مفعل وجاهز للعمل
            ai_tokens: 5,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        // ✅ 8. إنشاء رمز الإحالة
        const referralCode = generateReferralCode(full_name, newTeacher.id);
        await supabase
            .from('teachers')
            .update({ referral_code: referralCode, status: 'approved', profile_completion: true, is_certified: false })
            .eq('id', newTeacher.id);

        // ✅ 9. معالجة الإحالة إذا وجدت
        const effectiveRef = ref || req.cookies?.referral_code || req.cookies?.pendingReferral;
        if (effectiveRef && String(effectiveRef).trim().length > 3) {
            await processReferralOnRegister(String(effectiveRef).trim(), newTeacher.id, 'teacher');
        }

        // ✅ 10. إرسال إشعار للمدير
        try {
            await insert('notifications', {
                user_id: 1,
                user_type: 'admin',
                title: '👨‍🏫 انضمام أستاذ جديد',
                message: `انضم الأستاذ ${full_name} إلى المنصة كأستاذ موثق.`,
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (notifError) {
            logger.error('⚠️ خطأ في إرسال إشعار للمدير:', notifError.message);
        }

        // ✅ 11. إنشاء توكن للأستاذ (تسجيل الدخول التلقائي)
        const token = generateToken(newTeacher.id, 'teacher', email);

        // ✅ 12. الرد بنجاح
        res.json({
            success: true,
            token: token,
            message: '✅ تم إنشاء حسابك بنجاح! حسابك نشط وموثق وجاهز للاستخدام مباشرة.',
            teacher_id: newTeacher.id,
            email: email,
            role: 'teacher',
            status: 'approved',
            is_certified: false,
            profile_completion: true,
            requires_profile_completion: false,
            user: processUserProfile({
                id: newTeacher.id,
                name: full_name,
                full_name: full_name,
                role: 'teacher',
                status: 'approved',
                is_certified: false,
                profile_completion: true
            }, 'teacher')
        });

    } catch (error) {
        logger.error('❌ خطأ في تسجيل أستاذ:', error.message);
        logger.error('📚 Stack:', error.stack);
        res.status(500).json({
            success: false,
            error: `❌ حدث خطأ في الخادم أثناء التسجيل: ${error.message || error}. يرجى المحاولة مرة أخرى أو الاتصال بالدعم.`,
            details: error.stack || error.message || error
        });
    }
});

// ============================================================
// ✅ تسجيل طالب جديد (مع المستوى التعليمي)
// ============================================================
router.post('/student/register', checkBanned, [
    body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب').isLength({ max: 100 }),
    body('email').notEmpty().withMessage('البريد الإلكتروني مطلوب').trim().custom((val) => {
        if (!isValidEmail(val)) {
            throw new Error('⚠️ صيغة البريد الإلكتروني غير صحيحة (مثال: example@gmail.com)');
        }
        return true;
    }),
    body('password').notEmpty().withMessage('كلمة المرور مطلوبة'),
    body('phone').notEmpty().withMessage('رقم الهاتف مطلوب').trim().custom((val) => {
        if (!isValidDzPhone(val)) {
            throw new Error('⚠️ رقم الهاتف يجب أن يكون برقم جزائري صحيح (مثال: 0550123456 أو 0660123456 أو 0770123456)');
        }
        return true;
    }),
    body('education_level').notEmpty().withMessage('المستوى الدراسي مطلوب')
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

        // ✅ 3. التحقق من فرادة الاسم وعدم تكراره في المنصة (أساتذة وطلاب)
        const nameCheck = await isNameTaken(full_name);
        if (nameCheck.taken) {
            return res.status(400).json({
                success: false,
                error: '⚠️ هذا الاسم الكامل مستخدم مسبقاً في المنصة. يرجى اختيار اسم فريد لتمييز حسابك.'
            });
        }

        // ✅ 4. التحقق من وجود البريد في جدول الطلاب
        const existingStudent = await getOne('students', 'email', email);
        if (existingStudent) {
            return res.status(400).json({
                success: false,
                error: '⚠️ البريد الإلكتروني مستخدم مسبقاً. يرجى استخدام بريد إلكتروني آخر.'
            });
        }

        // ✅ 5. التحقق من وجود البريد في جدول الأساتذة أيضاً
        const existingTeacher = await getOne('teachers', 'email', email);
        if (existingTeacher) {
            return res.status(400).json({
                success: false,
                error: '⚠️ هذا البريد الإلكتروني مستخدم كأستاذ. يرجى استخدام بريد إلكتروني آخر.'
            });
        }

        // ✅ 6. تشفير كلمة المرور
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        // ✅ 7. إنشاء الطالب في قاعدة البيانات
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
            ai_tokens: 5,
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
        const effectiveRef = ref || req.cookies?.referral_code || req.cookies?.pendingReferral;
        if (effectiveRef && String(effectiveRef).trim().length > 3) {
            await processReferralOnRegister(String(effectiveRef).trim(), newStudent.id, 'student');
        }

        // ✅ 9. إنشاء توكن للطالب (تسجيل الدخول التلقائي)
        const token = generateToken(newStudent.id, 'student', email);

        // ✅ 10. إرسال إشعار ترحيب
        try {
            await insert('notifications', {
                user_id: newStudent.id,
                user_type: 'student',
                title: '🎉 مرحباً بك في ZoomDz!',
                message: `مرحباً ${full_name}! نتمنى لك تجربة تعليمية ممتعة. يمكنك البدء بحجز الدروس من قسم "الدروس".`,
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (notifError) {
            logger.error('⚠️ خطأ في إرسال إشعار الترحيب:', notifError.message);
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
        logger.error('❌ خطأ في تسجيل طالب:', error.message);
        logger.error('📚 Stack:', error.stack);
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
            const isVerified = verifyAdminCredentials(email, password);
            if (!isVerified) {
                return res.status(401).json({ success: false, error: '❌ بيانات الدخول غير صحيحة' });
            }

            const token = generateToken(0, 'admin', ADMIN_EMAIL);

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
            // ✅ تسجيل دخول المدير كأستاذ برتبة مدير
            if (verifyAdminCredentials(email, password)) {
                let adminTeacher = await getOne('teachers', 'email', ADMIN_EMAIL);
                if (!adminTeacher) {
                    try {
                        adminTeacher = await insert('teachers', {
                            full_name: 'مدير المنصة',
                            email: ADMIN_EMAIL,
                            password: await bcrypt.hash(password, SALT_ROUNDS),
                            status: 'approved',
                            rank: 'مدير',
                            subject: 'إدارة المنصة',
                            bio: 'حساب إدارة المنصة المباشر - أستاذ ومدير',
                            profile_completion: true,
                            email_verified: true,
                            balance: 100000,
                            created_at: new Date().toISOString()
                        });
                    } catch (e) {
                        logger.error('خطأ في إنشاء حساب أستاذ للآدمن:', e);
                    }
                } else if (adminTeacher.rank !== 'مدير' || adminTeacher.status !== 'approved') {
                    try {
                        await update('teachers', adminTeacher.id, {
                            rank: 'مدير',
                            status: 'approved'
                        });
                    } catch (e) {}
                    adminTeacher.rank = 'مدير';
                    adminTeacher.status = 'approved';
                }

                resetLoginAttempts(email);
                const teacherId = adminTeacher ? adminTeacher.id : 0;
                const token = generateToken(teacherId, 'teacher', ADMIN_EMAIL);

                return res.json({
                    success: true,
                    token: token,
                    redirectTo: '/teacher-dashboard.html',
                    user: processUserProfile({
                        id: teacherId,
                        name: 'مدير المنصة',
                        full_name: 'مدير المنصة',
                        role: 'teacher',
                        rank: 'مدير',
                        is_admin: true,
                        profile_image: adminTeacher?.profile_image,
                        profile_url: adminTeacher?.profile_url,
                        balance: adminTeacher?.balance || 100000,
                        email_verified: true,
                        subject: 'إدارة المنصة',
                        status: 'approved',
                        requires_profile_completion: false,
                        profile_completion: true
                    }, 'teacher')
                });
            }

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
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            trackLoginAttempt(email);
            return res.status(401).json({
                success: false,
                error: '❌ كلمة المرور خاطئة. يرجى المحاولة مرة أخرى.'
            });
        }

        resetLoginAttempts(email);

        // ✅ التحقق من حالة الأستاذ
        if (userRole === 'teacher') {
            if (user.status === 'rejected') {
                return res.json({
                    success: true,
                    token: generateToken(user.id, userRole, email),
                    redirectTo: '/teacher-dashboard.html',
                    user: processUserProfile({
                        id: user.id,
                        name: user.full_name,
                        full_name: user.full_name,
                        role: userRole,
                        profile_image: user.profile_image,
                        profile_url: user.profile_url,
                        balance: user.balance || 0,
                        email_verified: user.email_verified,
                        referral_code: user.referral_code,
                        education_level: user.education_level || null,
                        teaching_level: user.teaching_level || null,
                        status: 'rejected',
                        rejection_reason: user.rejection_reason || null,
                        is_certified: false,
                        requires_profile_completion: false,
                        profile_completion: true
                    }, userRole),
                    requires_profile_completion: false,
                    status: 'rejected',
                    rejection_reason: user.rejection_reason || 'لم يتم تحديد سبب'
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
                logger.error('خطأ في تسجيل سجل الدخول:', logError.message);
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
        const userData = processUserProfile({
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
        }, userRole);

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
            email: req.body?.email,
            role: req.body?.role,
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
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
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
            // ✅ الأستاذ لا يحتاج لتأكيد البريد الإلكتروني
            return res.status(400).json({ success: false, error: 'حساب الأستاذ لا يحتاج لتأكيد البريد الإلكتروني' });
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
        logger.error('خطأ في إعادة إرسال التأكيد:', error.message);
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

        if (!['student'].includes(role)) {
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
        logger.error('خطأ في تأكيد البريد:', error.message);
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
        logger.error('خطأ في طلب إعادة التعيين:', error.message);
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
        logger.error('خطأ في التحقق من رمز إعادة التعيين:', error.message);
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

        const hashedPassword = await bcrypt.hash(new_password, SALT_ROUNDS);
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
        logger.error('خطأ في إعادة تعيين كلمة المرور:', error.message);
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
        user = processUserProfile(user, role);

        res.json({
            success: true,
            user: {
                ...user,
                role: role,
                has_active_stream: hasActiveStream,
                active_offer: activeOffer
            }
        });
    } catch (error) {
        logger.error('خطأ في جلب معلومات المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

const { 
    getGoogleAuthUrl, 
    exchangeCodeForTokens, 
    saveTeacherGoogleToken, 
    getTeacherGoogleToken, 
    removeTeacherGoogleToken 
} = require('../utils/googleMeet');

// ============================================================
// ✅ مسارات Google Meet OAuth 2.0 للأستاذ
// ============================================================

// 1. رابط بدء تفويض Google Meet للأستاذ
router.get('/auth/google/teacher-connect', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const redirectUri = `${protocol}://${host}/api/auth/google/callback`;
        if (!process.env.GOOGLE_CLIENT_ID) {
            return res.status(400).json({ 
                success: false, 
                error: 'لم يتم إعداد بيانات ربط جوجل (GOOGLE_CLIENT_ID) في الخادم بعد. تواصل مع الإدارة.' 
            });
        }
        
        const authUrl = getGoogleAuthUrl(redirectUri, req.user.userId);
        
        res.json({
            success: true,
            url: authUrl,
            redirect_uri: redirectUri
        });
    } catch (e) {
        logger.error('خطأ في توليد رابط OAuth لجوجل:', e.message);
        res.status(500).json({ success: false, error: 'تعذر إنشاء رابط الاتصال بجوجل' });
    }
});

// 2. استقبال التفويض من جوجل وبدء حجز مفتاح التجديد الدائم
router.get(['/auth/google/callback', '/auth/google/callback/'], async (req, res) => {
    try {
        const { code, state, error: googleError } = req.query;
        if (googleError || !code) {
            return res.status(400).send(`
                <html>
                    <body style="font-family:sans-serif; text-align:center; padding:40px; background:#f8fafc;">
                        <h2 style="color:#ef4444;">❌ تم إلغاء الربط أو حدث خطأ من جوجل</h2>
                        <p>${googleError || 'لم يتم استلام كود التفويض'}</p>
                        <script>setTimeout(() => window.close(), 3000);</script>
                    </body>
                </html>
            `);
        }

        let teacherId = null;
        if (state) {
            try {
                const parsed = JSON.parse(decodeURIComponent(state));
                teacherId = parsed.teacherId;
            } catch (e) {
                teacherId = state;
            }
        }

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const redirectUri = `${protocol}://${host}/api/auth/google/callback`;

        const tokens = await exchangeCodeForTokens(code, redirectUri);
        
        if (!tokens || !tokens.access_token) {
            return res.status(400).send(`
                <html>
                    <body style="font-family:sans-serif; text-align:center; padding:40px; background:#f8fafc;">
                        <h2 style="color:#ef4444;">❌ تعذر استبدال المفاتيح مع جوجل</h2>
                        <script>setTimeout(() => window.close(), 3000);</script>
                    </body>
                </html>
            `);
        }

        if (teacherId) {
            await saveTeacherGoogleToken(teacherId, tokens, tokens.email);
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <title>تم ربط Google Meet بنجاح</title>
                <style>
                    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #eff6ff; color: #1e3a8a; }
                    .card { background: white; padding: 30px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.08); text-align: center; max-width: 400px; width: 90%; border: 2px solid #bfdbfe; }
                    .icon { font-size: 48px; margin-bottom: 15px; }
                    h2 { margin: 0 0 10px 0; color: #1d4ed8; font-size: 1.4rem; }
                    p { color: #475569; font-size: 0.95rem; line-height: 1.5; margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon">🎉</div>
                    <h2>تم ربط حساب Google Meet بنجاح!</h2>
                    <p>الآن يمكن للمنصة إنشاء غرف Google Meet تلقائياً في الخلفية تحت حسابك <strong>${tokens.email || ''}</strong>.</p>
                    <script>
                        if (window.opener) {
                            window.opener.postMessage({
                                type: 'GOOGLE_MEET_CONNECTED',
                                success: true,
                                email: '${tokens.email || ''}'
                            }, '*');
                            setTimeout(() => window.close(), 2000);
                        } else {
                            setTimeout(() => { window.location.href = '/teacher-dashboard.html'; }, 2000);
                        }
                    </script>
                </div>
            </body>
            </html>
        `);
    } catch (e) {
        logger.error('خطأ في إكمال Google OAuth Callback:', e.message);
        res.status(500).send(`
            <html>
                <body style="font-family:sans-serif; text-align:center; padding:40px; background:#f8fafc;">
                    <h2 style="color:#ef4444;">❌ حدث خطأ غير متوقع أثناء ربط الحساب</h2>
                    <p>${e.message}</p>
                    <script>setTimeout(() => window.close(), 3000);</script>
                </body>
            </html>
        `);
    }
});

// 3. حالة ربط حساب جوجل للأستاذ
router.get('/auth/google/status', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const tokenRecord = await getTeacherGoogleToken(req.user.userId);
        if (tokenRecord && tokenRecord.refresh_token) {
            return res.json({
                success: true,
                is_connected: true,
                google_email: tokenRecord.google_email || null,
                updated_at: tokenRecord.updated_at || null
            });
        }
        res.json({
            success: true,
            is_connected: false,
            google_email: null
        });
    } catch (e) {
        res.status(500).json({ success: false, is_connected: false, error: e.message });
    }
});

// 4. إلغاء ربط حساب جوجل
router.post('/auth/google/disconnect', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        await removeTeacherGoogleToken(req.user.userId);
        res.json({ success: true, message: 'تم إلغاء ربط حساب Google Meet بنجاح' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// ✅ مسارات المصادقة والتسجيل عبر Google & إكمال الملف الشخصي
// ============================================================
const { 
    GOOGLE_CLIENT_ID, 
    verifyGoogleIdToken, 
    exchangeGoogleCode, 
    getGoogleAuthUrl: getGoogleLoginAuthUrl 
} = require('../utils/googleAuth');

// 1. إرجاع إعدادات Google OAuth للواجهة الأمامية
router.get('/google/config', (req, res) => {
    res.json({
        success: true,
        client_id: GOOGLE_CLIENT_ID
    });
});

// 2. توليد رابط تفويض Google OAuth للمصادقة
router.get('/google/url', (req, res) => {
    try {
        const { role = 'student', ref = '' } = req.query;
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const redirectUri = `${protocol}://${host}/api/auth/google/oauth-callback`;
        const stateObj = { role, ref, redirectUri };
        const state = encodeURIComponent(JSON.stringify(stateObj));
        const authUrl = getGoogleLoginAuthUrl(redirectUri, state);

        res.json({
            success: true,
            url: authUrl,
            redirect_uri: redirectUri
        });
    } catch (e) {
        logger.error('خطأ في توليد رابط Google OAuth:', e.message);
        res.status(500).json({ success: false, error: 'تعذر توليد رابط المصادقة عبر Google' });
    }
});

// 3. تسجيل الدخول أو إنشاء حساب جديد عبر Google
router.post('/google', checkBanned, authLimiter, async (req, res) => {
    try {
        const { credential, code, role = 'student', ref, redirect_uri } = req.body;

        if (!credential && !code) {
            return res.status(400).json({
                success: false,
                error: 'رمز التحقق من جوجل مفقود (credential أو code)'
            });
        }

        let googleUser = null;
        if (credential) {
            googleUser = await verifyGoogleIdToken(credential);
        } else if (code) {
            const protocol = req.headers['x-forwarded-proto'] || req.protocol;
            const host = req.get('host');
            const defaultRedirect = `${protocol}://${host}/api/auth/google/oauth-callback`;
            googleUser = await exchangeGoogleCode(code, redirect_uri || defaultRedirect);
        }

        if (!googleUser || !googleUser.email) {
            return res.status(400).json({
                success: false,
                error: 'فشل استرجاع بيانات الحساب من جوجل'
            });
        }

        const email = googleUser.email.toLowerCase().trim();
        const fullName = (googleUser.name || email.split('@')[0]).trim();
        const profileImage = googleUser.picture || null;
        const targetRole = (role === 'teacher' || role === 'admin') ? role : 'student';

        logger.info(`🔑 محاولة دخول / تسجيل عبر Google: ${email} كـ ${targetRole}`);

        // التحقق من وجود الحساب في جدول الأساتذة
        let teacher = await getOne('teachers', 'email', email);
        // التحقق من وجود الحساب في جدول الطلاب
        let student = await getOne('students', 'email', email);

        // الحالة 1: المستخدم مسجل بالفعل كأستاذ
        if (teacher) {
            if (teacher.is_banned) {
                return res.status(403).json({
                    success: false,
                    error: `⛔ تم حظر حسابك من المنصة. السبب: ${teacher.ban_reason || 'انتهاك شروط الاستخدام'}`
                });
            }

            // تحديث صورة الملف الشخصي إذا لم تكن موجودة
            if (!teacher.profile_image && profileImage) {
                try {
                    await update('teachers', teacher.id, { profile_image: profileImage, profile_url: profileImage });
                    teacher.profile_image = profileImage;
                    teacher.profile_url = profileImage;
                } catch (e) {}
            }

            const isProfileComplete = Boolean(
                teacher.phone && 
                (teacher.specialization || teacher.subject) && 
                (teacher.teaching_level || teacher.education_level) && 
                teacher.profile_completion !== false
            );
            const requiresCompletion = !isProfileComplete;

            const token = generateToken(teacher.id, 'teacher', email);

            return res.json({
                success: true,
                is_new: false,
                token: token,
                role: 'teacher',
                redirectTo: '/teacher-dashboard.html',
                requires_profile_completion: requiresCompletion,
                user: processUserProfile({
                    ...teacher,
                    role: 'teacher',
                    requires_profile_completion: requiresCompletion,
                    profile_completion: !requiresCompletion
                }, 'teacher')
            });
        }

        // الحالة 2: المستخدم مسجل بالفعل كطالب
        if (student) {
            if (student.is_banned) {
                return res.status(403).json({
                    success: false,
                    error: `⛔ تم حظر حسابك من المنصة. السبب: ${student.ban_reason || 'انتهاك شروط الاستخدام'}`
                });
            }

            // تحديث صورة الملف الشخصي إذا لم تكن موجودة
            if (!student.profile_image && profileImage) {
                try {
                    await update('students', student.id, { profile_image: profileImage, profile_url: profileImage });
                    student.profile_image = profileImage;
                    student.profile_url = profileImage;
                } catch (e) {}
            }

            const isProfileComplete = Boolean(
                student.phone && 
                student.education_level && 
                student.profile_completion !== false
            );
            const requiresCompletion = !isProfileComplete;

            const token = generateToken(student.id, 'student', email);

            return res.json({
                success: true,
                is_new: false,
                token: token,
                role: 'student',
                redirectTo: '/student-dashboard.html',
                requires_profile_completion: requiresCompletion,
                user: processUserProfile({
                    ...student,
                    role: 'student',
                    requires_profile_completion: requiresCompletion,
                    profile_completion: !requiresCompletion
                }, 'student')
            });
        }

        // الحالة 3: حساب جديد تماماً يتم إنشاؤه عبر Google
        const randomPassword = crypto.randomBytes(24).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, SALT_ROUNDS);

        if (targetRole === 'teacher') {
            const newTeacher = await insert('teachers', {
                full_name: fullName,
                email: email,
                password: hashedPassword,
                phone: null,
                specialization: null,
                subject: null,
                bio: null,
                experience: null,
                teaching_level: null,
                profile_image: profileImage,
                profile_url: profileImage,
                diploma_image: null,
                id_image: null,
                status: 'approved',
                is_certified: false,
                email_verified: true,
                balance: 0,
                referral_balance: 0,
                total_earned: 0,
                total_withdrawn: 0,
                pending_withdraw: 0,
                referral_code: null,
                is_banned: false,
                ban_reason: null,
                profile_completion: false,
                ai_tokens: 5,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

            const referralCode = generateReferralCode(fullName, newTeacher.id);
            try {
                await supabase
                    .from('teachers')
                    .update({ referral_code: referralCode })
                    .eq('id', newTeacher.id);
            } catch (e) {}

            const effectiveRef = ref || req.cookies?.referral_code || req.cookies?.pendingReferral;
            if (effectiveRef && String(effectiveRef).trim().length > 3) {
                await processReferralOnRegister(String(effectiveRef).trim(), newTeacher.id, 'teacher');
            }

            const token = generateToken(newTeacher.id, 'teacher', email);

            return res.json({
                success: true,
                is_new: true,
                token: token,
                role: 'teacher',
                redirectTo: '/teacher-dashboard.html',
                requires_profile_completion: true,
                message: 'تم التسجيل عبر Google بنجاح! يرجى إكمال بيانات ملفك الشخصي.',
                user: processUserProfile({
                    ...newTeacher,
                    role: 'teacher',
                    referral_code: referralCode,
                    requires_profile_completion: true,
                    profile_completion: false
                }, 'teacher')
            });
        } else {
            // إنشاء حساب طالب جديد
            const newStudent = await insert('students', {
                full_name: fullName,
                email: email,
                password: hashedPassword,
                phone: null,
                education_level: null,
                profile_image: profileImage,
                profile_url: profileImage,
                wallet_balance: 0,
                email_verified: true,
                referral_balance: 0,
                gift_box_chances: 0,
                referral_code: null,
                is_banned: false,
                ban_reason: null,
                profile_completion: false,
                ai_tokens: 5,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

            const referralCode = generateReferralCode(fullName, newStudent.id);
            try {
                await supabase
                    .from('students')
                    .update({ referral_code: referralCode })
                    .eq('id', newStudent.id);
            } catch (e) {}

            const effectiveRef = ref || req.cookies?.referral_code || req.cookies?.pendingReferral;
            if (effectiveRef && String(effectiveRef).trim().length > 3) {
                await processReferralOnRegister(String(effectiveRef).trim(), newStudent.id, 'student');
            }

            const token = generateToken(newStudent.id, 'student', email);

            return res.json({
                success: true,
                is_new: true,
                token: token,
                role: 'student',
                redirectTo: '/student-dashboard.html',
                requires_profile_completion: true,
                message: 'تم التسجيل عبر Google بنجاح! يرجى إكمال بيانات ملفك الشخصي.',
                user: processUserProfile({
                    ...newStudent,
                    role: 'student',
                    referral_code: referralCode,
                    requires_profile_completion: true,
                    profile_completion: false
                }, 'student')
            });
        }
    } catch (error) {
        logger.error('❌ خطأ في مسار Google Auth:', error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'حدث خطأ أثناء المصادقة عبر Google'
        });
    }
});

// 4. معالجة إعادة التوجيه من Google OAuth Callback (Popup أو Redirect)
router.get('/google/oauth-callback', async (req, res) => {
    try {
        const { code, state, error: googleError } = req.query;
        if (googleError || !code) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html lang="ar" dir="rtl">
                <head><meta charset="UTF-8"><title>فشل تسجيل الدخول</title></head>
                <body style="font-family:sans-serif; text-align:center; padding:50px; background:#f8fafc;">
                    <h2 style="color:#ef4444;">❌ تم إلغاء التسجيل عبر Google</h2>
                    <p>${googleError || 'لم يتم استلام كود المصادقة'}</p>
                    <script>
                        if (window.opener) {
                            window.opener.postMessage({ type: 'GOOGLE_AUTH_ERROR', error: '${googleError || 'تم الإلغاء'}' }, '*');
                            setTimeout(() => window.close(), 2000);
                        } else {
                            setTimeout(() => { window.location.href = '/'; }, 2000);
                        }
                    </script>
                </body>
                </html>
            `);
        }

        let role = 'student';
        let ref = '';
        let redirectUri = '';
        if (state) {
            try {
                const parsed = JSON.parse(decodeURIComponent(state));
                role = parsed.role || 'student';
                ref = parsed.ref || '';
                redirectUri = parsed.redirectUri || '';
            } catch (e) {
                role = state;
            }
        }

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const defaultRedirect = `${protocol}://${host}/api/auth/google/oauth-callback`;
        const effectiveRedirectUri = redirectUri || defaultRedirect;

        const googleUser = await exchangeGoogleCode(code, effectiveRedirectUri);
        const email = googleUser.email.toLowerCase().trim();
        const fullName = (googleUser.name || email.split('@')[0]).trim();
        const profileImage = googleUser.picture || null;

        let teacher = await getOne('teachers', 'email', email);
        let student = await getOne('students', 'email', email);

        let finalRole = role;
        let finalUser = null;
        let token = null;
        let requiresCompletion = false;

        if (teacher) {
            finalRole = 'teacher';
            finalUser = teacher;
            token = generateToken(teacher.id, 'teacher', email);
            requiresCompletion = !teacher.phone || !teacher.specialization || !teacher.teaching_level || !teacher.profile_completion;
        } else if (student) {
            finalRole = 'student';
            finalUser = student;
            token = generateToken(student.id, 'student', email);
            requiresCompletion = !student.phone || !student.education_level || !student.profile_completion;
        } else {
            // مستخدم جديد
            const randomPassword = crypto.randomBytes(24).toString('hex');
            const hashedPassword = await bcrypt.hash(randomPassword, SALT_ROUNDS);

            if (role === 'teacher') {
                finalRole = 'teacher';
                finalUser = await insert('teachers', {
                    full_name: fullName,
                    email: email,
                    password: hashedPassword,
                    phone: null,
                    specialization: null,
                    subject: null,
                    bio: null,
                    experience: null,
                    teaching_level: null,
                    profile_image: profileImage,
                    profile_url: profileImage,
                    status: 'approved',
                    is_certified: false,
                    email_verified: true,
                    balance: 0,
                    referral_balance: 0,
                    profile_completion: false,
                    ai_tokens: 5,
                    created_at: new Date().toISOString()
                });
                const referralCode = generateReferralCode(fullName, finalUser.id);
                try {
                    await supabase.from('teachers').update({ referral_code: referralCode }).eq('id', finalUser.id);
                } catch (e) {}
                if (ref) await processReferralOnRegister(ref, finalUser.id, 'teacher');
                token = generateToken(finalUser.id, 'teacher', email);
                requiresCompletion = true;
            } else {
                finalRole = 'student';
                finalUser = await insert('students', {
                    full_name: fullName,
                    email: email,
                    password: hashedPassword,
                    phone: null,
                    education_level: null,
                    profile_image: profileImage,
                    profile_url: profileImage,
                    wallet_balance: 0,
                    email_verified: true,
                    profile_completion: false,
                    referral_balance: 0,
                    gift_box_chances: 0,
                    ai_tokens: 5,
                    created_at: new Date().toISOString()
                });
                const referralCode = generateReferralCode(fullName, finalUser.id);
                try {
                    await supabase.from('students').update({ referral_code: referralCode }).eq('id', finalUser.id);
                } catch (e) {}
                if (ref) await processReferralOnRegister(ref, finalUser.id, 'student');
                token = generateToken(finalUser.id, 'student', email);
                requiresCompletion = true;
            }
        }

        const processedUser = processUserProfile({
            ...finalUser,
            role: finalRole,
            requires_profile_completion: requiresCompletion,
            profile_completion: !requiresCompletion
        }, finalRole);

        const targetDashboard = finalRole === 'teacher' ? '/teacher-dashboard.html' : '/student-dashboard.html';

        res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <title>تم تسجيل الدخول بنجاح</title>
                <style>
                    body { font-family: system-ui, -apple-system, sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; background:#f0fdf4; color:#166534; }
                    .card { background:white; padding:32px; border-radius:16px; box-shadow:0 10px 25px rgba(0,0,0,0.08); text-align:center; max-width:420px; width:90%; border:2px solid #bbf7d0; }
                    .icon { font-size:48px; margin-bottom:12px; }
                    h2 { margin:0 0 10px 0; color:#15803d; }
                    p { color:#475569; font-size:0.95rem; margin-bottom:20px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon">✨</div>
                    <h2>تم تسجيل الدخول عبر Google بنجاح!</h2>
                    <p>مرحباً بك <strong>${fullName}</strong>، جاري نقلك إلى لوحة التحكم...</p>
                </div>
                <script>
                    const authPayload = {
                        success: true,
                        token: '${token}',
                        role: '${finalRole}',
                        redirectTo: '${targetDashboard}',
                        requires_profile_completion: ${requiresCompletion},
                        user: ${JSON.stringify(processedUser)}
                    };

                    localStorage.setItem('token', authPayload.token);
                    localStorage.setItem('userData', JSON.stringify(authPayload.user));

                    if (window.opener) {
                        window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS', data: authPayload }, '*');
                        setTimeout(() => window.close(), 1200);
                    } else {
                        setTimeout(() => { window.location.href = '${targetDashboard}'; }, 1000);
                    }
                </script>
            </body>
            </html>
        `);

    } catch (e) {
        logger.error('خطأ في معالجة Google OAuth callback:', e.message);
        res.status(500).send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head><meta charset="UTF-8"><title>خطأ في تسجيل الدخول</title></head>
            <body style="font-family:sans-serif; text-align:center; padding:50px; background:#fef2f2;">
                <h2 style="color:#dc2626;">❌ حدث خطأ أثناء المصادقة عبر Google</h2>
                <p>${e.message}</p>
                <script>setTimeout(() => { window.location.href = '/'; }, 3000);</script>
            </body>
            </html>
        `);
    }
});

// 5. مسار إكمال الملف الشخصي المشترك (للطالب والأستاذ)
router.post('/complete-profile', authenticate, async (req, res) => {
    try {
        const userId = req.user.userId;
        const userRole = req.user.role;
        const { 
            phone, 
            education_level, 
            teaching_level, 
            specialization, 
            subject, 
            bio, 
            experience, 
            full_name 
        } = req.body;

        logger.info(`📝 طلب إكمال الملف الشخصي للمستخدم #${userId} (${userRole})`);

        if (userRole === 'student') {
            if (!phone || !isValidDzPhone(phone)) {
                return res.status(400).json({
                    success: false,
                    error: '⚠️ رقم الهاتف مطلوب ويجب أن يكون رقم هاتف جزائري صحيح (مثال: 0550123456 أو 0660123456 أو 0770123456)'
                });
            }

            if (!education_level || !String(education_level).trim()) {
                return res.status(400).json({
                    success: false,
                    error: '⚠️ المستوى الدراسي مطلوب'
                });
            }

            const updateData = {
                phone: phone.trim(),
                education_level: String(education_level).trim(),
                profile_completion: true,
                updated_at: new Date().toISOString()
            };

            if (full_name && String(full_name).trim()) {
                const cleanName = String(full_name).trim();
                const nameCheck = await isNameTaken(cleanName, userId, 'student');
                if (nameCheck.taken) {
                    return res.status(400).json({
                        success: false,
                        error: '⚠️ هذا الاسم الكامل مستخدم مسبقاً، يرجى اختيار اسم آخر'
                    });
                }
                updateData.full_name = cleanName;
            }

            const { data, error } = await supabase
                .from('students')
                .update(updateData)
                .eq('id', userId)
                .select();

            if (error) {
                logger.error('Supabase error updating student profile completion:', error.message);
                await update('students', userId, updateData);
            }

            const student = await getOne('students', 'id', userId);
            const processed = processUserProfile({
                ...student,
                role: 'student',
                profile_completion: true,
                requires_profile_completion: false
            }, 'student');

            return res.json({
                success: true,
                message: '✅ تم إكمال وتأكيد ملفك الشخصي بنجاح!',
                user: processed
            });

        } else if (userRole === 'teacher') {
            if (!phone || !isValidDzPhone(phone)) {
                return res.status(400).json({
                    success: false,
                    error: '⚠️ رقم الهاتف مطلوب ويجب أن يكون رقم هاتف جزائري صحيح (مثال: 0550123456 أو 0660123456 أو 0770123456)'
                });
            }

            const spec = specialization || subject;
            if (!spec || !String(spec).trim()) {
                return res.status(400).json({
                    success: false,
                    error: '⚠️ التخصص أو المادة التدريسية مطلوبة'
                });
            }

            const level = teaching_level || education_level;
            if (!level || !String(level).trim()) {
                return res.status(400).json({
                    success: false,
                    error: '⚠️ المستوى التعليمي المدرس مطلوب'
                });
            }

            const updateData = {
                phone: phone.trim(),
                specialization: String(spec).trim(),
                subject: String(spec).trim(),
                teaching_level: String(level).trim(),
                bio: bio ? String(bio).trim() : null,
                experience: experience ? String(experience).trim() : null,
                profile_completion: true,
                updated_at: new Date().toISOString()
            };

            if (full_name && String(full_name).trim()) {
                const cleanName = String(full_name).trim();
                const nameCheck = await isNameTaken(cleanName, userId, 'teacher');
                if (nameCheck.taken) {
                    return res.status(400).json({
                        success: false,
                        error: '⚠️ هذا الاسم الكامل مستخدم مسبقاً، يرجى اختيار اسم آخر'
                    });
                }
                updateData.full_name = cleanName;
            }

            const { data, error } = await supabase
                .from('teachers')
                .update(updateData)
                .eq('id', userId)
                .select();

            if (error) {
                logger.error('Supabase error updating teacher profile completion:', error.message);
                await update('teachers', userId, updateData);
            }

            const teacher = await getOne('teachers', 'id', userId);
            const processed = processUserProfile({
                ...teacher,
                role: 'teacher',
                profile_completion: true,
                requires_profile_completion: false
            }, 'teacher');

            return res.json({
                success: true,
                message: '✅ تم إكمال وتأكيد ملفك الشخصي بنجاح!',
                user: processed
            });
        } else {
            return res.status(400).json({ success: false, error: 'نوع الحساب غير مدعوم' });
        }
    } catch (error) {
        logger.error('❌ خطأ في إكمال الملف الشخصي:', error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'حدث خطأ أثناء حفظ بيانات الملف الشخصي'
        });
    }
});

// ============================================================
// ✅ التحقق من توفر الاسم (عدم التكرار)
// ============================================================
router.get('/check-name', async (req, res) => {
    try {
        const { name, exclude_user_id, exclude_role } = req.query;
        if (!name || !String(name).trim()) {
            return res.json({ available: false, error: 'الاسم مطلوب' });
        }

        const nameCheck = await isNameTaken(String(name).trim(), exclude_user_id, exclude_role);
        if (nameCheck.taken) {
            return res.json({
                available: false,
                taken: true,
                message: nameCheck.role === 'teacher' 
                    ? '⚠️ هذا الاسم مسجل مسبقاً لأستاذ على المنصة.'
                    : '⚠️ هذا الاسم مسجل مسبقاً لطالب على المنصة.'
            });
        }

        res.json({
            available: true,
            taken: false,
            message: '✅ الاسم متاح ويمكن استخدامه'
        });
    } catch (e) {
        logger.error('خطأ في التحقق من الاسم:', e.message);
        res.status(500).json({ available: true, error: e.message });
    }
});

module.exports = router;
