// ============================================================
// مسارات المصادقة - Auth Routes (معدل لدعم المستوى التعليمي)
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
const { generateToken, verifyToken } = require('../utils/jwt');
const { sendVerificationEmail, sendResetEmail } = require('../utils/email');
const { processReferralOnRegister } = require('../utils/referral');
const { uploadToSupabase, validateUploadedFiles } = require('../utils/upload');
const { verifyRecaptcha } = require('../utils/validation');

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
// ✅ دالة للتحقق من وجود جدول student_room_passwords وإنشائه إذا لم يكن موجوداً
// ============================================================
async function ensureStudentRoomPasswordsTable() {
    try {
        const { error: checkError } = await supabase
            .from('student_room_passwords')
            .select('id')
            .limit(1);
        
        if (checkError && checkError.message && checkError.message.includes('relation "student_room_passwords" does not exist')) {
            console.log('⚠️ جدول student_room_passwords غير موجود، سيتم إنشاؤه تلقائياً...');
            
            try {
                const createTableSQL = `
                    CREATE TABLE IF NOT EXISTS student_room_passwords (
                        id BIGSERIAL PRIMARY KEY,
                        offer_id INTEGER NOT NULL,
                        student_id INTEGER NOT NULL,
                        password TEXT NOT NULL,
                        used BOOLEAN DEFAULT FALSE,
                        used_at TIMESTAMP,
                        created_at TIMESTAMP DEFAULT NOW(),
                        UNIQUE(offer_id, student_id)
                    );
                `;
                
                const { error: createError } = await supabase.rpc('exec_sql', { sql: createTableSQL });
                
                if (createError) {
                    console.error('❌ فشل إنشاء الجدول تلقائياً:', createError.message);
                    console.log('⚠️ يرجى إنشاء الجدول يدوياً في Supabase SQL Editor باستخدام:');
                    console.log(createTableSQL);
                    return false;
                }
                
                console.log('✅ تم إنشاء جدول student_room_passwords بنجاح');
                return true;
            } catch (rpcError) {
                console.error('❌ فشل إنشاء الجدول عبر RPC:', rpcError.message);
                console.log('⚠️ يرجى إنشاء الجدول يدوياً في Supabase SQL Editor');
                return false;
            }
        }
        
        console.log('✅ جدول student_room_passwords موجود');
        return true;
    } catch (error) {
        console.error('❌ خطأ في التحقق من جدول student_room_passwords:', error.message);
        return false;
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
    body('teaching_level').notEmpty().withMessage('المستوى الدراسي مطلوب'), // ✅ إضافة المستوى التعليمي
    body('recaptcha_token').notEmpty().withMessage('رمز reCAPTCHA مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { full_name, email, password, phone, specialization, bio, experience, teaching_level, recaptcha_token, ref } = req.body;

        console.log(`📥 تسجيل أستاذ جديد: ${full_name}, المستوى: ${teaching_level}`);

        const recaptchaResult = await verifyRecaptcha(recaptcha_token);
        if (!recaptchaResult.success) {
            return res.status(400).json({ success: false, error: recaptchaResult.error });
        }

        const existingTeacher = await getOne('teachers', 'email', email);
        if (existingTeacher) {
            return res.status(400).json({ success: false, error: 'البريد الإلكتروني مستخدم مسبقاً' });
        }

        const hashedPassword = bcrypt.hashSync(password, SALT_ROUNDS);
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

        // ✅ إضافة teaching_level إلى بيانات الأستاذ
        const newTeacher = await insert('teachers', {
            full_name: full_name.trim(),
            email: email.trim(),
            password: hashedPassword,
            phone: phone.trim(),
            specialization: specialization.trim(),
            bio: bio.trim(),
            experience: experience.trim(),
            teaching_level: teaching_level.trim(), // ✅ حفظ المستوى التعليمي
            profile_image,
            profile_url,
            diploma_image,
            id_image,
            status: 'pending',
            email_verified: false,
            balance: 0,
            referral_balance: 0,
            total_earned: 0,
            total_withdrawn: 0,
            pending_withdraw: 0,
            referral_code: null,
            is_banned: false,
            ban_reason: null
        });

        const referralCode = generateReferralCode(full_name, newTeacher.id);
        await supabase
            .from('teachers')
            .update({ referral_code: referralCode })
            .eq('id', newTeacher.id);

        const verificationToken = generateVerificationToken();
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        await insert('email_verifications', {
            email: email,
            role: 'teacher',
            token: verificationToken,
            expires_at: expiresAt.toISOString(),
            used: false,
            created_at: new Date().toISOString()
        });

        const baseUrl = process.env.PLATFORM_URL ||
                        (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
        const verificationUrl = `${baseUrl}/api/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}&role=teacher`;
        
        const emailSent = await sendVerificationEmail(email, full_name, verificationUrl);

        await ensureStudentRoomPasswordsTable();

        if (ref && ref.length > 3) {
            await processReferralOnRegister(ref, newTeacher.id, 'teacher');
        }

        const token = generateToken(newTeacher.id, 'teacher', email);

        res.json({ 
            success: true, 
            message: 'تم تسجيل حسابك بنجاح! يرجى تأكيد بريدك الإلكتروني من خلال الرابط المرسل إليك.',
            email_verification_sent: emailSent,
            email: email,
            role: 'teacher',
            teaching_level: teaching_level, // ✅ إرجاع المستوى التعليمي
            referral_code: referralCode,
            token: token
        });
    } catch (error) {
        console.error('❌ خطأ في تسجيل أستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
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
    body('education_level').notEmpty().withMessage('المستوى الدراسي مطلوب'), // ✅ إضافة المستوى التعليمي
    body('recaptcha_token').notEmpty().withMessage('رمز reCAPTCHA مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { full_name, email, password, phone, education_level, recaptcha_token, ref } = req.body;

        console.log(`📥 تسجيل طالب جديد: ${full_name}, المستوى: ${education_level}`);

        const recaptchaResult = await verifyRecaptcha(recaptcha_token);
        if (!recaptchaResult.success) {
            return res.status(400).json({ success: false, error: recaptchaResult.error });
        }

        const existingStudent = await getOne('students', 'email', email);
        if (existingStudent) {
            return res.status(400).json({ success: false, error: 'البريد الإلكتروني مستخدم' });
        }

        const hashedPassword = bcrypt.hashSync(password, SALT_ROUNDS);
        
        // ✅ إضافة education_level إلى بيانات الطالب
        const newStudent = await insert('students', {
            full_name: full_name.trim(),
            email: email.trim(),
            password: hashedPassword,
            phone: phone.trim(),
            education_level: education_level.trim(), // ✅ حفظ المستوى التعليمي
            wallet_balance: 0,
            email_verified: false,
            referral_balance: 0,
            gift_box_chances: 0,
            referral_code: null,
            is_banned: false,
            ban_reason: null
        });

        const referralCode = generateReferralCode(full_name, newStudent.id);
        await supabase
            .from('students')
            .update({ referral_code: referralCode })
            .eq('id', newStudent.id);

        const verificationToken = generateVerificationToken();
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        await insert('email_verifications', {
            email: email,
            role: 'student',
            token: verificationToken,
            expires_at: expiresAt.toISOString(),
            used: false,
            created_at: new Date().toISOString()
        });

        const baseUrl = process.env.PLATFORM_URL ||
                        (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
        const verificationUrl = `${baseUrl}/api/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}&role=student`;
        
        const emailSent = await sendVerificationEmail(email, full_name, verificationUrl);

        await ensureStudentRoomPasswordsTable();

        if (ref && ref.length > 3) {
            await processReferralOnRegister(ref, newStudent.id, 'student');
        }

        const token = generateToken(newStudent.id, 'student', email);

        res.json({ 
            success: true, 
            message: 'تم تسجيل حسابك بنجاح! يرجى تأكيد بريدك الإلكتروني من خلال الرابط المرسل إليك.',
            email_verification_sent: emailSent,
            email: email,
            role: 'student',
            education_level: education_level, // ✅ إرجاع المستوى التعليمي
            referral_code: referralCode,
            token: token
        });
    } catch (error) {
        console.error('❌ خطأ في تسجيل طالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تسجيل الدخول
// ============================================================
router.post('/login', checkBanned, authLimiter, [
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('password').notEmpty().withMessage('كلمة المرور مطلوبة'),
    body('role').isIn(['student', 'teacher', 'admin']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { email, password, role } = req.body;

        if (role === 'admin') {
            if (email !== ADMIN_EMAIL) {
                return res.status(401).json({ success: false, error: 'بيانات الدخول غير صحيحة' });
            }
            
            const isValid = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
            if (!isValid) {
                return res.status(401).json({ success: false, error: 'بيانات الدخول غير صحيحة' });
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

        const attempt = trackLoginAttempt(email);
        if (attempt.locked) {
            return res.status(429).json({
                success: false,
                error: `تم تجاوز عدد المحاولات المسموح بها. يرجى المحاولة بعد ${Math.ceil(LOCKOUT_TIME / 60000)} دقائق`
            });
        }

        let user = null;
        let userRole = 'teacher';

        if (role === 'teacher') {
            user = await getOne('teachers', 'email', email);
            userRole = 'teacher';
        } else if (role === 'student') {
            user = await getOne('students', 'email', email);
            userRole = 'student';
        }

        if (!user) {
            trackLoginAttempt(email);
            return res.status(404).json({ success: false, error: 'البريد الإلكتروني غير موجود' });
        }

        if (user.is_banned === true) {
            return res.status(403).json({
                success: false,
                error: 'تم حظر حسابك من المنصة',
                banned: true,
                reason: user.ban_reason || 'انتهاك شروط الاستخدام'
            });
        }

        const validPassword = bcrypt.compareSync(password, user.password);
        if (!validPassword) {
            trackLoginAttempt(email);
            return res.status(401).json({ success: false, error: 'كلمة المرور خاطئة' });
        }

        resetLoginAttempts(email);

        if (!user.email_verified) {
            return res.status(403).json({
                success: false,
                error: 'يرجى تأكيد بريدك الإلكتروني أولاً. تم إرسال رابط التأكيد إلى بريدك.',
                email_not_verified: true,
                email: user.email,
                role: userRole
            });
        }

        if (userRole === 'teacher' && user.status !== 'approved') {
            return res.status(403).json({ 
                success: false, 
                error: 'حسابك قيد المراجعة',
                pending_approval: true
            });
        }

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

        const token = generateToken(user.id, userRole, email);
        const redirectPath = userRole === 'teacher' ? '/teacher-dashboard.html' : '/student-dashboard.html';
        
        res.json({
            success: true,
            token: token,
            redirectTo: redirectPath,
            user: {
                id: user.id,
                name: user.full_name,
                role: userRole,
                profile_image: user.profile_image,
                profile_url: user.profile_url,
                balance: user.wallet_balance || user.balance || 0,
                email_verified: user.email_verified,
                referral_code: user.referral_code,
                education_level: user.education_level || null, // ✅ إرجاع المستوى التعليمي للطالب
                teaching_level: user.teaching_level || null // ✅ إرجاع المستوى التعليمي للأستاذ
            }
        });
    } catch (error) {
        console.error('خطأ في تسجيل الدخول:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تسجيل الخروج
// ============================================================
router.post('/logout', authenticate, (req, res) => {
    res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
});

// ============================================================
// إعادة إرسال رابط التأكيد
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
            res.json({ success: true, message: 'تم إرسال رابط تأكيد الحساب إلى بريدك الإلكتروني' });
        } else {
            res.json({
                success: true,
                message: `لم نتمكن من إرسال البريد. الرابط الخاص بك: ${verificationUrl}`,
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
// تأكيد البريد الإلكتروني
// ============================================================
router.get('/verify-email', async (req, res) => {
    try {
        const { token, email, role } = req.query;

        if (!token || !email || !role) {
            return res.status(400).send('رابط التحقق غير صالح');
        }

        if (!['student', 'teacher'].includes(role)) {
            return res.status(400).send('دور غير صالح');
        }

        const record = await getOne('email_verifications', 'token', token);

        if (!record || record.email !== email || record.role !== role || record.used || new Date(record.expires_at) < new Date()) {
            return res.status(400).send('رابط التحقق غير صالح أو منتهي الصلاحية');
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
                <title>تم تأكيد البريد</title>
                <script>setTimeout(() => window.location.href = '/?verified=1', 3000);</script>
                <style>
                    body { font-family: 'Cairo', sans-serif; text-align: center; padding: 40px; background: #f0f4ff; }
                    .card { background: white; border-radius: 20px; padding: 40px; max-width: 500px; margin: auto; box-shadow: 0 10px 40px rgba(0,0,0,0.1); }
                    h1 { color: #10b981; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>✅ تم تأكيد بريدك الإلكتروني بنجاح!</h1>
                    <p>سيتم تحويلك إلى صفحة تسجيل الدخول...</p>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('خطأ في تأكيد البريد:', error.message);
        res.status(500).send('حدث خطأ في الخادم');
    }
});

// ============================================================
// طلب إعادة تعيين كلمة المرور
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
            return res.status(404).json({ success: false, error: 'لا يوجد حساب بهذا البريد الإلكتروني' });
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
            res.json({ success: true, message: 'تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك الإلكتروني' });
        } else {
            res.json({
                success: true,
                message: 'تم إنشاء رابط إعادة التعيين',
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
// التحقق من رمز إعادة التعيين
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
            return res.status(400).json({ success: false, error: 'رابط إعادة التعيين غير صالح أو منتهي الصلاحية' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في التحقق من رمز إعادة التعيين:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إعادة تعيين كلمة المرور
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
            return res.status(400).json({ success: false, error: 'رابط إعادة التعيين غير صالح أو منتهي الصلاحية' });
        }

        const table = role === 'student' ? 'students' : 'teachers';
        const user = await getOne(table, 'email', email);

        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }

        const hashedPassword = bcrypt.hashSync(new_password, SALT_ROUNDS);
        await update(table, user.id, {
            password: hashedPassword,
            updated_at: new Date().toISOString()
        });

        await markPasswordResetUsed(token);

        res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
    } catch (error) {
        console.error('خطأ في إعادة تعيين كلمة المرور:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
