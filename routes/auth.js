// ============================================================
// مسارات المصادقة - Auth Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// استيراد الدوال المساعدة
const { supabase } = require('../config/database');
const { authenticate, authorize, checkBanned } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { getOne, insert, update, generateVerificationToken, generateReferralCode, sanitizeObject } = require('../utils/helpers');
const { encrypt, maskIP } = require('../utils/encryption');
const { generateToken, verifyToken } = require('../utils/jwt');
const { sendVerificationEmail, sendResetEmail } = require('../utils/email');
const { uploadToSupabase, validateUploadedFiles, ALLOWED_MIME_TYPES, ALLOWED_EXTENSIONS, MAX_FILE_SIZE } = require('../utils/upload');
const { verifyRecaptcha } = require('../utils/validation');
const { processReferralOnRegister } = require('../utils/referral');

// الثوابت
const SALT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@platform.com';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('admin123', 12);
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'https://chatvidio.vercel.app';

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
// إعداد Multer
// ============================================================
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 5
    },
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
// تسجيل أستاذ جديد
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
    body('recaptcha_token').notEmpty().withMessage('رمز reCAPTCHA مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { full_name, email, password, phone, specialization, bio, experience, recaptcha_token } = req.body;

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

        if (req.files?.['profile_image']?.[0]) {
            const uploaded = await uploadToSupabase(req.files['profile_image'][0], 'teachers');
            if (uploaded) {
                profile_image = uploaded.filename;
                profile_url = uploaded.url;
            }
        }

        if (req.files?.['diploma_image']?.[0]) {
            const uploaded = await uploadToSupabase(req.files['diploma_image'][0], 'diplomas');
            if (uploaded) diploma_image = uploaded.filename;
        }

        if (req.files?.['id_image']?.[0]) {
            const uploaded = await uploadToSupabase(req.files['id_image'][0], 'ids');
            if (uploaded) id_image = uploaded.filename;
        }

        const newTeacher = await insert('teachers', {
            full_name: full_name.trim(),
            email: email.trim(),
            password: hashedPassword,
            phone: phone.trim(),
            specialization: specialization.trim(),
            bio: bio.trim(),
            experience: experience.trim(),
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

        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
        const verificationUrl = `${baseUrl}/api/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}&role=teacher`;
        
        const emailSent = await sendVerificationEmail(email, full_name, verificationUrl);

        const refCode = req.cookies?.referral_code || req.query.ref;
        if (refCode) {
            try {
                await processReferralOnRegister(refCode, newTeacher.id, 'teacher');
            } catch (e) {
                console.error('خطأ في معالجة الإحالة:', e.message);
            }
        }

        const token = generateToken(newTeacher.id, 'teacher', email);

        res.json({ 
            success: true, 
            message: 'تم تسجيل حسابك بنجاح! يرجى تأكيد بريدك الإلكتروني من خلال الرابط المرسل إليك.',
            email_verification_sent: emailSent,
            email: email,
            role: 'teacher',
            referral_code: referralCode,
            token: token
        });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تسجيل طالب جديد
// ============================================================
router.post('/student/register', checkBanned, [
    body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب').isLength({ max: 100 }),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('كلمة المرور يجب أن تحتوي على حرف كبير وحرف صغير ورقم'),
    body('phone').notEmpty().withMessage('رقم الهاتف مطلوب'),
    body('recaptcha_token').notEmpty().withMessage('رمز reCAPTCHA مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { full_name, email, password, phone, recaptcha_token } = req.body;

        const recaptchaResult = await verifyRecaptcha(recaptcha_token);
        if (!recaptchaResult.success) {
            return res.status(400).json({ success: false, error: recaptchaResult.error });
        }

        const existingStudent = await getOne('students', 'email', email);
        if (existingStudent) {
            return res.status(400).json({ success: false, error: 'البريد الإلكتروني مستخدم' });
        }

        const hashedPassword = bcrypt.hashSync(password, SALT_ROUNDS);
        
        const newStudent = await insert('students', {
            full_name: full_name.trim(),
            email: email.trim(),
            password: hashedPassword,
            phone: phone.trim(),
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

        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
        const verificationUrl = `${baseUrl}/api/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}&role=student`;
        
        const emailSent = await sendVerificationEmail(email, full_name, verificationUrl);

        const refCode = req.cookies?.referral_code || req.query.ref;
        if (refCode) {
            try {
                await processReferralOnRegister(refCode, newStudent.id, 'student');
            } catch (e) {
                console.error('خطأ في معالجة الإحالة:', e.message);
            }
        }

        const token = generateToken(newStudent.id, 'student', email);

        res.json({ 
            success: true, 
            message: 'تم تسجيل حسابك بنجاح! يرجى تأكيد بريدك الإلكتروني من خلال الرابط المرسل إليك.',
            email_verification_sent: emailSent,
            email: email,
            role: 'student',
            referral_code: referralCode,
            token: token
        });
    } catch (error) {
        console.error('خطأ:', error.message);
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

        // تسجيل دخول المدير
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

        // التحقق من محاولات تسجيل الدخول
        const attempt = trackLoginAttempt(email);
        if (attempt.locked) {
            return res.status(429).json({
                success: false,
                error: `تم تجاوز عدد المحاولات المسموح بها. يرجى المحاولة بعد ${Math.ceil(LOCKOUT_TIME / 60000)} دقائق`
            });
        }

        let user = await getOne('teachers', 'email', email);
        let userRole = 'teacher';

        if (!user) {
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

        if (role !== userRole) {
            return res.status(400).json({
                success: false,
                error: `هذا الحساب مسجل كـ ${userRole === 'teacher' ? 'أستاذ' : 'طالب'}`
            });
        }

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

        // تسجيل IP
        let ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
        if (ip && typeof ip === 'string' && ip.includes(',')) {
            ip = ip.split(',')[0].trim();
        }
        if (ip && typeof ip === 'string') {
            ip = ip.replace(/:\d+[^:]*$/, '');
        }

        if (ip) {
            const encryptedIP = encrypt(ip);
            await insert('login_logs', {
                user_id: user.id,
                user_role: userRole,
                ip_address_encrypted: encryptedIP,
                ip_address_masked: maskIP(ip),
                created_at: new Date().toISOString()
            });
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
                referral_code: user.referral_code
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

        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
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
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تأكيد البريد الإلكتروني
// ============================================================
router.get('/verify-email', [
    require('express-validator').query('token').notEmpty().withMessage('الرمز مطلوب'),
    require('express-validator').query('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
    require('express-validator').query('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    const { token, email, role } = req.query;

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).send(renderErrorPage('بيانات غير صالحة', 'البيانات المرسلة غير صالحة'));
        }

        const { data: verification, error } = await supabase
            .from('email_verifications')
            .select('*')
            .eq('token', token)
            .eq('email', email)
            .eq('role', role)
            .eq('used', false)
            .single();

        if (error || !verification) {
            return res.status(400).send(renderErrorPage('رمز غير صالح', 'رمز التحقق غير صالح أو تم استخدامه بالفعل.'));
        }

        const expiresAt = new Date(verification.expires_at);
        if (expiresAt < new Date()) {
            await supabase
                .from('email_verifications')
                .update({ used: true })
                .eq('token', token);

            return res.status(400).send(renderErrorPage('انتهت الصلاحية', 'انتهت صلاحية رابط التأكيد. يمكنك طلب رابط جديد من خلال صفحة تسجيل الدخول.', '/'));
        }

        const tableName = role === 'student' ? 'students' : 'teachers';
        
        await supabase
            .from(tableName)
            .update({ email_verified: true })
            .eq('email', email);

        await supabase
            .from('email_verifications')
            .update({ used: true })
            .eq('token', token);

        // معالجة مكافأة الإحالة
        const user = await getOne(tableName, 'email', email);
        if (user) {
            const { processReferralReward } = require('../utils/referral');
            await processReferralReward(user.id, role);
        }

        return res.send(renderSuccessPage('تم تأكيد الحساب', 'تم تأكيد حسابك بنجاح 🎉', 'يمكنك الآن تسجيل الدخول والاستفادة من جميع خدمات المنصة.', 'تسجيل الدخول', '/'));
    } catch (error) {
        console.error('خطأ في تأكيد البريد:', error.message);
        return res.status(500).send(renderErrorPage('حدث خطأ', 'حدث خطأ أثناء تأكيد الحساب. يرجى المحاولة مرة أخرى.'));
    }
});

// ============================================================
// دوال عرض الصفحات
// ============================================================
function renderSuccessPage(title, message, subMessage, buttonText, buttonLink) {
    return `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>${title}</title>
        <style>
            body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
            .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
            h1{color:#10b981;font-size:2.5rem}
            .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
            .btn:hover{background:#0a4a9a}
            .sub{color:#666;margin-top:10px}
        </style>
        </head>
        <body>
        <div class="card">
            <h1>✅ ${title}</h1>
            <p style="font-size:1.2rem;">${message}</p>
            <p class="sub">${subMessage}</p>
            <a href="${buttonLink || '/'}" class="btn">${buttonText || 'العودة للرئيسية'}</a>
        </div>
        </body>
        </html>
    `;
}

function renderErrorPage(title, message, buttonLink) {
    return `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>خطأ</title>
        <style>
            body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
            .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
            h1{color:#dc2626}
            .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
        </style>
        </head>
        <body>
        <div class="card">
            <h1>❌ ${title}</h1>
            <p>${message}</p>
            <a href="${buttonLink || '/'}" class="btn">العودة للرئيسية</a>
        </div>
        </body>
        </html>
    `;
}

// ============================================================
// نسيت كلمة المرور
// ============================================================
router.post('/forgot-password', authLimiter, [
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { email, role } = req.body;

        let user = null;
        if (role === 'student') {
            user = await getOne('students', 'email', email);
        } else if (role === 'teacher') {
            user = await getOne('teachers', 'email', email);
        }

        if (!user) {
            return res.status(404).json({ success: false, error: 'لا يوجد حساب بهذا البريد الإلكتروني' });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 1);

        await insert('password_resets', {
            email: email,
            role: role,
            token: resetToken,
            expires_at: expiresAt.toISOString(),
            used: false,
            created_at: new Date().toISOString()
        });

        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
        const resetUrl = `${baseUrl}/reset-password.html?token=${resetToken}&email=${encodeURIComponent(email)}&role=${role}`;

        const emailSent = await sendResetEmail(email, user.full_name, resetUrl);

        if (emailSent) {
            res.json({ success: true, message: 'تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك الإلكتروني' });
        } else {
            res.json({
                success: true,
                message: `لم نتمكن من إرسال البريد. الرابط الخاص بك: ${resetUrl}`,
                showDirectLink: true,
                resetUrl: resetUrl
            });
        }
    } catch (error) {
        console.error('خطأ:', error.message);
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

        const { data: resetRecord } = await supabase
            .from('password_resets')
            .select('*')
            .eq('token', token)
            .eq('email', email)
            .eq('role', role)
            .eq('used', false)
            .single();

        if (!resetRecord) {
            return res.status(400).json({ success: false, error: 'رابط إعادة التعيين غير صالح أو تم استخدامه بالفعل' });
        }

        const expiresAt = new Date(resetRecord.expires_at);
        if (expiresAt < new Date()) {
            return res.status(400).json({ success: false, error: 'انتهت صلاحية رابط إعادة التعيين' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('خطأ:', error.message);
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
    body('new_password').isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('كلمة المرور يجب أن تحتوي على حرف كبير وحرف صغير ورقم')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { token, email, role, new_password } = req.body;

        const { data: resetRecord } = await supabase
            .from('password_resets')
            .select('*')
            .eq('token', token)
            .eq('email', email)
            .eq('role', role)
            .eq('used', false)
            .single();

        if (!resetRecord) {
            return res.status(400).json({ success: false, error: 'رابط إعادة التعيين غير صالح' });
        }

        const expiresAt = new Date(resetRecord.expires_at);
        if (expiresAt < new Date()) {
            return res.status(400).json({ success: false, error: 'انتهت صلاحية رابط إعادة التعيين' });
        }

        const hashedPassword = bcrypt.hashSync(new_password, SALT_ROUNDS);
        const tableName = role === 'student' ? 'students' : 'teachers';

        await supabase
            .from(tableName)
            .update({ password: hashedPassword })
            .eq('email', email);

        await supabase
            .from('password_resets')
            .update({ used: true })
            .eq('token', token);

        res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
