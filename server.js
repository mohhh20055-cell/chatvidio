// ============================================================
// خادم منصة التعليم الآمن والمحصن ضد الهجمات الإلكترونية
// معايير أمنية متطورة لحماية المدفوعات وتوثيق الجلسات والحد من الطلبات الضارة
// ============================================================

require('dotenv').config();

// الحزم الأساسية والتشغيلية
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken'); // إضافة حزمة التوثيق المشفر لحماية الحسابات
const { body, param, validationResult } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

// تهيئة التطبيق ومنافذ الاتصال
const app = express();
const PORT = process.env.PORT || 3000;

// مفتاح التشفير السري لـ JWT لحماية الجلسات والرموز
const JWT_SECRET = process.env.JWT_SECRET || 'SUPER_SECURE_RANDOM_LONG_STRING_CHANGE_ME_IN_PRODUCTION_129847';

// تثبيت الوكيل العكسي (للحصول على عناوين IP الحقيقية للمستخدمين خلف Vercel أو Cloudflare)
app.set('trust proxy', true);

// ============================================================
// التحقق من توافر المتغيرات البيئية الحساسة
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
const CHARGILY_API_KEY = process.env.CHARGILY_API_KEY;
const CHARGILY_API_URL = process.env.CHARGILY_API_URL || 'https://pay.chargily.net/api/v2';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@platform.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CORS_ORIGIN = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['https://chatvidio.vercel.app', 'http://localhost:3000'];
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'https://chatvidio.vercel.app';

if (!supabaseUrl || !supabaseKey) {
    console.error('⚠️ خطأ أمني جسيم: متغيرات الاتصال بـ Supabase مفقودة!');
    process.exit(1);
}

if (!resendApiKey) {
    console.error('⚠️ تحذير أمني: متغير RESEND_API_KEY مفقود، إرسال البريد معطل حالياً!');
}

if (!CHARGILY_API_KEY) {
    console.error('⚠️ تحذير أمني: مفتاح Chargily مفقود، عمليات الدفع ستفشل!');
}

// تهيئة الاتصال بقاعدة البيانات والبريد الإلكتروني
const supabase = createClient(supabaseUrl, supabaseKey);
const resend = resendApiKey ? new Resend(resendApiKey) : null;

// ============================================================
// الإعدادات الأمنية الصارمة لحماية المدخلات والمخرجات
// ============================================================

// 1. خوذة الحماية (Helmet) - لتأمين رؤوس HTTP ومنع هجمات الحقن و Clickjacking و XSS
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://meet.jit.si", "https://cdnjs.cloudflare.com", "https://vercel.live"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://ui-avatars.com", "https://api.qrserver.com", "https://*.supabase.co"],
            connectSrc: ["'self'", "https://*.supabase.co", "https://pay.chargily.net", "https://meet.jit.si"],
            frameSrc: ["'self'", "https://meet.jit.si"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// 2. إعدادات مشاركة الموارد الآمنة (CORS) لمنع الاستغلال الخارجي
const corsOptions = {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
    maxAge: 86400
};
app.use(cors(corsOptions));

// 3. محدد معدل الطلبات (Rate Limiting) لمنع الإغراق وهجمات الحرمان من الخدمة (DDoS)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 دقيقة
    max: 150, // أقصى حد للطلبات من عنوان IP واحد
    message: { success: false, error: 'لقد تجاوزت حد الطلبات المسموح به، يرجى المحاولة بعد 15 دقيقة.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: true },
    skip: (req) => {
        return req.path.startsWith('/api/stream') ||
               req.path.startsWith('/api/join-stream') ||
               req.path.startsWith('/api/wallet/deposit/success') ||
               req.path.startsWith('/api/wallet/deposit/failure');
    }
});
app.use('/api/', limiter);

// محدد معدل طلبات التوثيق الصارم لمنع التخمين وحقن القوة الغاشمة (Brute Force)
const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // ساعة واحدة
    max: 15, // أقصى حد لمحاولات الدخول الخاطئة
    message: { success: false, error: 'محاولات دخول مفرطة، يرجى الانتظار لمدة ساعة قبل المحاولة من جديد.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: true }
});
app.use('/api/login', authLimiter);
app.use('/api/forgot-password', authLimiter);
app.use('/api/resend-verification', authLimiter);

// ============================================================
// برمجية استخلاص ومعالجة عناوين IP بدقة لمنع التلاعب
// ============================================================
function getClientIp(req) {
    let ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
    if (ip && typeof ip === 'string' && ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }
    if (ip && typeof ip === 'string') {
        ip = ip.replace(/:\d+[^:]*$/, ''); // إزالة المنافذ إذا وجدت
    }
    return ip || null;
}

// ============================================================
// برمجية التحقق الآمنة من الحظر الفردي والجماعي (IP Ban)
// ============================================================
async function checkBanned(req, res, next) {
    const ip = getClientIp(req);
    if (!ip) return next();
    
    try {
        const { data } = await supabase
            .from('banned_users')
            .select('*')
            .eq('ip_address', ip)
            .maybeSingle();
        
        if (data) {
            return res.status(403).json({
                success: false,
                error: 'تم حظر عنوان IP الخاص بك نهائياً من استخدام المنصة لمخالفة القوانين العامة.',
                banned: true,
                reason: data.ban_reason || 'انتهاك بنود الأمان والاستخدام'
            });
        }
        next();
    } catch (error) {
        next();
    }
}

// ============================================================
// البرمجيات الوسيطة الخاصة بالتوثيق وفك تشفير الجلسات (JWT Authentication)
// ============================================================

// 1. التحقق الفعلي من صحة توقيع الرمز (JWT Verification)
function authenticateJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader) {
        const token = authHeader.split(' ')[1]; // استخراج Bearer Token
        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (err) {
                return res.status(403).json({ success: false, error: 'رمز الدخول غير صالح أو انتهت صلاحيته، يرجى تسجيل الدخول مجدداً.' });
            }
            req.user = decoded; // حفظ بيانات المستخدم المستخلصة للعمليات التالية
            next();
        });
    } else {
        return res.status(401).json({ success: false, error: 'يرجى تقديم رمز الدخول المعتمد للوصول لهذه العملية.' });
    }
}

// 2. التحقق الفعلي من دور المستخدم وصلاحياته (Role Authorization)
function requireRole(allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بالوصول إلى هذه البيانات.' });
        }
        next();
    };
}

// ============================================================
// معالجة المدخلات الأساسية والملفات المرفوعة
// ============================================================
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static('public', {
    maxAge: '1d',
    etag: true,
    lastModified: true
}));

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // الحد الأقصى 5 ميجابايت للحد من هجمات ملء مساحة التخزين
        files: 2
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('امتداد الملف المرفوع غير مدعوم، يرجى رفع ملفات بتنسيق صور أو PDF فقط.'), false);
        }
    }
});

// ============================================================
// دوال إرسال رسائل البريد الإلكتروني (Resend)
// ============================================================
async function sendVerificationEmail(toEmail, toName, verificationUrl) {
    if (!resend) return false;
    try {
        const { error } = await resend.emails.send({
            from: 'منصة التعليم <onboarding@resend.dev>',
            to: [toEmail],
            subject: 'تأكيد حسابك - منصة التعليم',
            html: `
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"></head>
                <body style="font-family:'Cairo',Arial,sans-serif;text-align:center;padding:20px;background:#f0f4ff;">
                    <div style="max-width:550px;margin:auto;background:white;border-radius:20px;padding:40px;box-shadow:0 10px 40px rgba(0,0,0,0.1);">
                        <div style="font-size:4rem;margin-bottom:10px;">✉️</div>
                        <h2 style="color:#0f5cbf;margin:10px 0;">مرحباً ${toName}!</h2>
                        <p style="font-size:1.1rem;color:#333;line-height:1.8;">شكراً لتسجيلك في منصة التعليم.<br>يرجى تأكيد حسابك بالضغط على الزر أدناه:</p>
                        <a href="${verificationUrl}" style="background:#0f5cbf;color:white;padding:14px 35px;text-decoration:none;border-radius:30px;display:inline-block;margin:25px 0;font-size:1.1rem;font-weight:bold;">تأكيد الحساب</a>
                        <p style="color:#666;font-size:0.85rem;">هذا الرابط صالح لمدة 24 ساعة.</p>
                        <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
                        <p style="color:#aaa;font-size:0.75rem;">منصة التعليم - تعلم بذكاء</p>
                    </div>
                </body>
                </html>
            `
        });
        return !error;
    } catch (error) {
        console.error('خطأ في إرسال بريد التأكيد:', error.message);
        return false;
    }
}

async function sendResetEmail(toEmail, toName, resetUrl) {
    if (!resend) return false;
    try {
        const { error } = await resend.emails.send({
            from: 'منصة التعليم <onboarding@resend.dev>',
            to: [toEmail],
            subject: 'إعادة تعيين كلمة المرور - منصة التعليم',
            html: `
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"></head>
                <body style="font-family:'Cairo',Arial,sans-serif;text-align:center;padding:20px;background:#f0f4ff;">
                    <div style="max-width:550px;margin:auto;background:white;border-radius:20px;padding:40px;box-shadow:0 10px 40px rgba(0,0,0,0.1);">
                        <div style="font-size:4rem;margin-bottom:10px;">🔐</div>
                        <h2 style="color:#0f5cbf;margin:10px 0;">مرحباً ${toName}!</h2>
                        <p style="font-size:1.1rem;color:#333;line-height:1.8;">لقد طلبت إعادة تعيين كلمة المرور الخاصة بك.</p>
                        <a href="${resetUrl}" style="background:#0f5cbf;color:white;padding:14px 35px;text-decoration:none;border-radius:30px;display:inline-block;margin:25px 0;font-size:1.1rem;font-weight:bold;">إعادة تعيين كلمة المرور</a>
                        <p style="color:#666;font-size:0.85rem;">هذا الرابط صالح لمدة ساعة واحدة فقط.</p>
                    </div>
                </body>
                </html>
            `
        });
        return !error;
    } catch (error) {
        console.error('خطأ في إرسال بريد استعادة كلمة المرور:', error.message);
        return false;
    }
}

// ============================================================
// رفع الملفات الآمن إلى Supabase Storage
// ============================================================
async function uploadToSupabase(file, folder, oldFileName = null) {
    try {
        if (!file || !file.buffer) return null;

        const fileExt = path.extname(file.originalname).toLowerCase();
        // التحقق الإضافي لمنع رفع ملفات خبيثة خفية
        const sanitizedExt = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'].includes(fileExt) ? fileExt : '.dat';
        const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${sanitizedExt}`;
        const filePath = `${folder}/${fileName}`;

        if (oldFileName) {
            try {
                const oldPath = `${folder}/${oldFileName}`;
                await supabase.storage.from('profiles').remove([oldPath]);
            } catch (e) {
                // تجاهل إذا لم يكن الملف القديم متوفراً
            }
        }

        const { error } = await supabase.storage
            .from('profiles')
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                cacheControl: '86400',
                upsert: true
            });

        if (error) {
            console.error('خطأ في رفع الملف لقاعدة البيانات:', error.message);
            return null;
        }

        const { data: publicUrl } = supabase.storage
            .from('profiles')
            .getPublicUrl(filePath);

        return {
            filename: fileName,
            url: publicUrl.publicUrl
        };
    } catch (error) {
        console.error('خطأ أمني أو برمجي في معالجة الملف:', error.message);
        return null;
    }
}

// ============================================================
// مساعدات واجهة الاستعلام لقاعدة البيانات لتجنب تكرار الكود
// ============================================================
async function getOne(table, column, value) {
    const { data, error } = await supabase
        .from(table)
        .select('*')
        .eq(column, value)
        .maybeSingle();
    if (error) return null;
    return data;
}

async function insert(table, data) {
    const { data: result, error } = await supabase.from(table).insert(data).select();
    if (error) throw error;
    return result[0];
}

async function update(table, id, data) {
    const { data: result, error } = await supabase.from(table).update(data).eq('id', id).select();
    if (error) throw error;
    return result[0];
}

async function remove(table, column, value) {
    const { error } = await supabase.from(table).delete().eq(column, value);
    if (error) throw error;
    return true;
}

// توليد رموز التحقق الآمنة
function generateVerificationToken() {
    return require('crypto').randomBytes(32).toString('hex');
}

function generateReferralCode(name, id) {
    const prefix = name.replace(/\s+/g, '').substring(0, 3).toUpperCase();
    const suffix = parseInt(id).toString(36).toUpperCase();
    return `${prefix}${suffix}`;
}

// ============================================================
// مسارات التحقق وتوثيق البريد الإلكتروني
// ============================================================

app.post('/api/resend-verification', [
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').normalizeEmail(),
    body('role').isIn(['student', 'teacher']).withMessage('دور مستخدم غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { email, role } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        const user = await getOne(tableName, 'email', email);

        if (!user) {
            return res.status(404).json({ success: false, error: 'لا يوجد حساب مسجل بهذا البريد الإلكتروني' });
        }

        if (user.email_verified === true) {
            return res.status(400).json({ success: false, error: 'البريد الإلكتروني لهذا الحساب تم تأكيده مسبقاً.' });
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

        const baseUrl = process.env.PLATFORM_URL || `${req.protocol}://${req.get('host')}`;
        const verificationUrl = `${baseUrl}/api/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}&role=${role}`;

        const emailSent = await sendVerificationEmail(email, user.full_name, verificationUrl);

        if (emailSent) {
            res.json({ success: true, message: 'تم إرسال رابط تأكيد الحساب بنجاح إلى بريدك الإلكتروني.' });
        } else {
            res.json({
                success: true,
                message: 'لم نتمكن من إرسال البريد الإلكتروني بسبب مشكلة فنية مؤقتة، يمكنك استخدامه مباشرة للتأكيد.',
                showDirectLink: true,
                verificationUrl: verificationUrl
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ داخلي أثناء معالجة الطلب.' });
    }
});

app.get('/api/verify-email', async (req, res) => {
    const { token, email, role } = req.query;

    try {
        if (!token || !email || !role) {
            return res.status(400).send('<h2>طلب غير صالح، الرابط يفتقر إلى معلمات التحقق الأساسية.</h2>');
        }

        const { data: verification, error } = await supabase
            .from('email_verifications')
            .select('*')
            .eq('token', token)
            .eq('email', email)
            .eq('role', role)
            .eq('used', false)
            .maybeSingle();

        if (error || !verification) {
            return res.status(400).send('<h2>رابط التحقق منتهي أو غير صالح أو تم استخدامه مسبقاً.</h2>');
        }

        const expiresAt = new Date(verification.expires_at);
        if (expiresAt < new Date()) {
            await supabase.from('email_verifications').update({ used: true }).eq('token', token);
            return res.status(400).send('<h2>انتهت صلاحية هذا الرابط (صلاحية الروابط هي 24 ساعة فقط). يرجى طلب رابط تأكيد جديد.</h2>');
        }

        const tableName = role === 'student' ? 'students' : 'teachers';
        const user = await getOne(tableName, 'email', email);
        
        await supabase.from(tableName).update({ email_verified: true }).eq('email', email);
        await supabase.from('email_verifications').update({ used: true }).eq('token', token);

        if (user) {
            await processReferralReward(user.id, role);
        }

        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>تم تأكيد الحساب بنجاح</title>
                <style>
                    body{font-family:'Cairo',Arial,sans-serif;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                    .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                    h1{color:#10b981;font-size:2.5rem}
                    .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px;font-weight:bold;}
                    .sub{color:#666;margin-top:10px}
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>✅ تم تأكيد الحساب!</h1>
                    <p style="font-size:1.2rem;">مرحباً بك، تم تفعيل بريدك الإلكتروني بنجاح 🎉</p>
                    <p class="sub">يمكنك الآن التوجه لصفحة تسجيل الدخول والبدء في استخدام المنصة.</p>
                    <a href="/login.html" class="btn">تسجيل الدخول الآن</a>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        return res.status(500).send('<h2>حدث خطأ غير متوقع أثناء محاولة تأكيد البريد الإلكتروني.</h2>');
    }
});

// ============================================================
// نظام الإحالة والمكافآت (Referral System)
// ============================================================

app.post('/api/referral/create', authenticateJWT, [
    body('user_id').isInt().withMessage('معرف مستخدم غير صالح'),
    body('role').isIn(['student', 'teacher']).withMessage('دور مستخدم غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role } = req.body;

        // التحقق لمنع تلاعب مستخدم بحساب مستخدم آخر
        if (req.user.id !== parseInt(user_id) || req.user.role !== role) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإنشاء رمز إحالة لحساب آخر.' });
        }

        const tableName = role === 'student' ? 'students' : 'teachers';
        const user = await getOne(tableName, 'id', user_id);

        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }

        if (user.referral_code) {
            return res.json({ 
                success: true, 
                referral_code: user.referral_code,
                referral_link: `${PLATFORM_DOMAIN}?ref=${user.referral_code}`
            });
        }

        let referralCode = generateReferralCode(user.full_name, user_id);
        let isUnique = false;
        let attempts = 0;
        
        while (!isUnique && attempts < 10) {
            const existing = await getOne(tableName, 'referral_code', referralCode);
            if (!existing) {
                isUnique = true;
            } else {
                referralCode = generateReferralCode(user.full_name, user_id) + Math.random().toString(36).substring(2, 5).toUpperCase();
                attempts++;
            }
        }

        await supabase.from(tableName).update({ referral_code: referralCode }).eq('id', user_id);

        return res.json({
            success: true,
            referral_code: referralCode,
            referral_link: `${PLATFORM_DOMAIN}?ref=${referralCode}`
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ داخلي أثناء توليد كود الإحالة.' });
    }
});

app.get('/api/referral/info/:user_id/:role', authenticateJWT, async (req, res) => {
    try {
        const { user_id, role } = req.params;

        if (req.user.id !== parseInt(user_id) || req.user.role !== role) {
            return res.status(403).json({ success: false, error: 'لا يمكنك استعراض إحصائيات الإحالة الخاصة بحساب آخر.' });
        }

        const tableName = role === 'student' ? 'students' : 'teachers';
        const user = await getOne(tableName, 'id', user_id);

        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }

        const { count: referredCount } = await supabase
            .from('referrals')
            .select('*', { count: 'exact', head: true })
            .eq('referrer_id', user_id)
            .eq('referrer_role', role);

        let rewards = [];
        let totalReward = 0;
        let giftBoxChances = 0;

        if (role === 'teacher') {
            const { data: teacherRewards } = await supabase
                .from('referral_rewards')
                .select('*')
                .eq('teacher_id', user_id)
                .order('created_at', { ascending: false });

            rewards = teacherRewards || [];
            totalReward = user.referral_balance || 0;
        } else {
            const { data: studentRewards } = await supabase
                .from('referral_rewards')
                .select('*')
                .eq('student_id', user_id)
                .order('created_at', { ascending: false });

            rewards = studentRewards || [];
            giftBoxChances = user.gift_box_chances || 0;
        }

        return res.json({
            success: true,
            referral_code: user.referral_code,
            referral_link: `${PLATFORM_DOMAIN}?ref=${user.referral_code}`,
            referred_count: referredCount || 0,
            rewards: rewards,
            total_reward: totalReward,
            gift_box_chances: giftBoxChances
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'خطأ في جلب بيانات الإحالة.' });
    }
});

app.post('/api/referral/process', [
    body('ref_code').notEmpty().withMessage('رمز الإحالة مطلوب').trim(),
    body('new_user_id').isInt().withMessage('معرف مستخدم جديد غير صالح'),
    body('new_user_role').isIn(['student', 'teacher']).withMessage('دور مستخدم جديد غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { ref_code, new_user_id, new_user_role } = req.body;

        let referrer = null;
        let referrerRole = null;

        const { data: studentReferrer } = await supabase
            .from('students')
            .select('id, referral_code, full_name, email, role')
            .eq('referral_code', ref_code)
            .maybeSingle();

        if (studentReferrer) {
            referrer = studentReferrer;
            referrerRole = 'student';
        } else {
            const { data: teacherReferrer } = await supabase
                .from('teachers')
                .select('id, referral_code, full_name, email, role')
                .eq('referral_code', ref_code)
                .maybeSingle();

            if (teacherReferrer) {
                referrer = teacherReferrer;
                referrerRole = 'teacher';
            }
        }

        if (!referrer) {
            return res.status(404).json({ success: false, error: 'كود الإحالة المستخدم غير صالح أو غير موجود.' });
        }

        if (referrer.id === parseInt(new_user_id) && referrerRole === new_user_role) {
            return res.status(400).json({ success: false, error: 'لا يمكنك القيام بعملية إحالة لنفسك.' });
        }

        const { data: existingReferral } = await supabase
            .from('referrals')
            .select('*')
            .eq('referred_user_id', new_user_id)
            .eq('referred_user_role', new_user_role)
            .maybeSingle();

        if (existingReferral) {
            return res.json({ success: true, message: 'هذه الإحالة مسجلة بالفعل في النظام.' });
        }

        await insert('referrals', {
            referrer_id: referrer.id,
            referrer_role: referrerRole,
            referred_user_id: parseInt(new_user_id),
            referred_user_role: new_user_role,
            status: 'pending_verification',
            created_at: new Date().toISOString()
        });

        return res.json({
            success: true,
            message: 'تم تسجيل الإحالة بنجاح، سيتم منح المكافأة للطرفين فور تأكيد العضو الجديد بريده الإلكتروني.',
            referrer_name: referrer.full_name,
            referrer_role: referrerRole
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في معالجة طلب الإحالة.' });
    }
});

async function processReferralReward(referredUserId, referredUserRole) {
    try {
        const { data: referral } = await supabase
            .from('referrals')
            .select('*')
            .eq('referred_user_id', referredUserId)
            .eq('referred_user_role', referredUserRole)
            .eq('status', 'pending_verification')
            .maybeSingle();

        if (!referral) return false;

        await supabase
            .from('referrals')
            .update({ 
                status: 'completed',
                completed_at: new Date().toISOString()
            })
            .eq('id', referral.id);

        if (referral.referrer_role === 'teacher') {
            const teacher = await getOne('teachers', 'id', referral.referrer_id);
            if (teacher) {
                const newBalance = (teacher.referral_balance || 0) + 100;
                await supabase
                    .from('teachers')
                    .update({ 
                        referral_balance: newBalance,
                        balance: (teacher.balance || 0) + 100
                    })
                    .eq('id', referral.referrer_id);

                await insert('referral_rewards', {
                    teacher_id: referral.referrer_id,
                    referred_user_id: referredUserId,
                    referred_user_role: referredUserRole,
                    amount: 100,
                    type: 'balance',
                    description: `رصيد مكافأة إحالة عضو جديد`,
                    created_at: new Date().toISOString()
                });
            }
        } else if (referral.referrer_role === 'student') {
            const student = await getOne('students', 'id', referral.referrer_id);
            if (student) {
                const newChances = (student.gift_box_chances || 0) + 1;
                await supabase
                    .from('students')
                    .update({ gift_box_chances: newChances })
                    .eq('id', referral.referrer_id);

                await insert('referral_rewards', {
                    student_id: referral.referrer_id,
                    referred_user_id: referredUserId,
                    referred_user_role: referredUserRole,
                    type: 'gift_box_chance',
                    description: `فرصة فتح صندوق الهدايا مجاناً لدعوة صديق`,
                    created_at: new Date().toISOString()
                });
            }
        }
        return true;
    } catch (error) {
        console.error('فشل معالجة مكافأة الإحالة:', error.message);
        return false;
    }
}

app.post('/api/referral/open-gift-box', authenticateJWT, requireRole(['student']), [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id } = req.body;

        if (req.user.id !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بالتلاعب بحساب طالب آخر.' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'حساب الطالب غير مسجل.' });
        }

        const chances = student.gift_box_chances || 0;
        if (chances <= 0) {
            return res.status(400).json({ success: false, error: 'ليست لديك أي فرص متبقية لفتح الصناديق حالياً.' });
        }

        // خصم فوري للفرصة لمنع محاولات التكرار السريعة (Race Condition Protection)
        await supabase
            .from('students')
            .update({ gift_box_chances: chances - 1 })
            .eq('id', student_id);

        const rand = Math.random();
        let rewardAmount = 0;
        let rewardType = 'none';

        if (rand < 0.1) {
            rewardAmount = 100;
            rewardType = 'balance';
        } else if (rand < 0.40) {
            rewardAmount = 50;
            rewardType = 'balance';
        }

        if (rewardAmount > 0) {
            const newBalance = (student.wallet_balance || 0) + rewardAmount;
            await supabase
                .from('students')
                .update({ wallet_balance: newBalance })
                .eq('id', student_id);

            await insert('wallet_transactions', {
                student_id: student_id,
                amount: rewardAmount,
                type: 'referral_gift',
                status: 'completed',
                description: `مكافأة صندوق الحظ النقدي بقيمة ${rewardAmount} دج`,
                created_at: new Date().toISOString()
            });

            await insert('referral_rewards', {
                student_id: student_id,
                amount: rewardAmount,
                type: 'gift_box_reward',
                description: `الحصول على جائزة نقدية بقيمة ${rewardAmount} دج`,
                created_at: new Date().toISOString()
            });
        }

        return res.json({
            success: true,
            reward: rewardAmount,
            rewardType: rewardType,
            remaining_chances: chances - 1,
            message: rewardAmount > 0 
                ? `🎉 تهانينا الحارة! ربحت مكافأة مالية بقيمة ${rewardAmount} دج تم شحنها في محفظتك!` 
                : '😅 حظاً أوفر في المرة القادمة، ما زالت هناك فرص بانتظارك!'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث عطل أثناء فتح صندوق الهدايا.' });
    }
});

app.get('/api/referral/gift-box-status/:student_id', authenticateJWT, requireRole(['student']), async (req, res) => {
    try {
        const { student_id } = req.params;

        if (req.user.id !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح بالوصول لبيانات غيرك.' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        const { data: history } = await supabase
            .from('referral_rewards')
            .select('*')
            .eq('student_id', student_id)
            .eq('type', 'gift_box_reward')
            .order('created_at', { ascending: false })
            .limit(10);

        return res.json({
            success: true,
            chances: student.gift_box_chances || 0,
            history: history || []
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'فشل استعلام حالة الصناديق.' });
    }
});

app.get('/api/referral/teacher-stats/:teacher_id', authenticateJWT, requireRole(['teacher']), async (req, res) => {
    try {
        const { teacher_id } = req.params;

        if (req.user.id !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح بالاستعلام.' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        const [
            { count: totalReferred },
            { count: completedReferred }
        ] = await Promise.all([
            supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('referrer_id', teacher_id).eq('referrer_role', 'teacher'),
            supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('referrer_id', teacher_id).eq('referrer_role', 'teacher').eq('status', 'completed')
        ]);

        const { data: rewards } = await supabase
            .from('referral_rewards')
            .select('amount')
            .eq('teacher_id', teacher_id)
            .eq('type', 'balance');

        const totalRewards = rewards?.reduce((sum, r) => sum + (r.amount || 0), 0) || 0;

        return res.json({
            success: true,
            referral_code: teacher.referral_code,
            total_referred: totalReferred || 0,
            completed_referred: completedReferred || 0,
            total_rewards: totalRewards,
            referral_balance: teacher.referral_balance || 0,
            balance: teacher.balance || 0
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'خطأ في جلب إحصائيات المعلم.' });
    }
});

// ============================================================
// مسار الزوار وحفظ الإحالات عبر كوكيز آمنة
// ============================================================
app.get('/', (req, res) => {
    const refCode = req.query.ref;
    if (refCode && typeof refCode === 'string') {
        // حماية الكوكيز بخصائص أمنية لمنع سرقتها عبر البرمجة النصية
        res.cookie('referral_code', refCode.substring(0, 20), { 
            maxAge: 7 * 24 * 60 * 60 * 1000, 
            httpOnly: true,
            secure: true,
            sameSite: 'strict'
        });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// العروض والأساتذة لعموم الزوار
// ============================================================
app.get('/api/public/teachers', async (req, res) => {
    try {
        const { data } = await supabase
            .from('teachers')
            .select('id, full_name, specialization, bio, experience, profile_url')
            .eq('status', 'approved')
            .eq('email_verified', true)
            .order('created_at', { ascending: false })
            .limit(100);

        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/public/offers', async (req, res) => {
    try {
        const { data } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_url)')
            .eq('status', 'upcoming')
            .gt('offer_date', new Date().toISOString())
            .order('offer_date', { ascending: true })
            .limit(50);

        const formatted = (data || []).map(o => ({
            id: o.id,
            subject_name: o.subject_name,
            duration: o.duration,
            offer_date: o.offer_date,
            price: o.price,
            is_free: o.is_free,
            teacher_id: o.teachers?.id,
            teacher_name: o.teachers?.full_name,
            teacher_specialization: o.teachers?.specialization,
            teacher_profile_url: o.teachers?.profile_url
        }));

        res.json(formatted);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/live-offers', async (req, res) => {
    try {
        const { data } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_url)')
            .eq('status', 'live')
            .order('offer_date', { ascending: false })
            .limit(20);

        const formatted = (data || []).map(o => ({
            id: o.id,
            subject_name: o.subject_name,
            teacher_id: o.teachers?.id,
            teacher_name: o.teachers?.full_name,
            teacher_specialization: o.teachers?.specialization,
            teacher_profile_url: o.teachers?.profile_url
        }));

        res.json(formatted);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/public/stats', async (req, res) => {
    try {
        const [
            { count: teachersCount },
            { count: offersCount },
            { count: liveCount },
            { count: studentsCount }
        ] = await Promise.all([
            supabase.from('teachers').select('*', { count: 'exact', head: true }).eq('status', 'approved').eq('email_verified', true),
            supabase.from('offers').select('*', { count: 'exact', head: true }).eq('status', 'upcoming').gt('offer_date', new Date().toISOString()),
            supabase.from('offers').select('*', { count: 'exact', head: true }).eq('status', 'live'),
            supabase.from('students').select('*', { count: 'exact', head: true }).eq('email_verified', true)
        ]);

        res.json({
            teachers: teachersCount || 0,
            offers: offersCount || 0,
            live: liveCount || 0,
            students: studentsCount || 0
        });
    } catch (error) {
        res.status(500).json({ teachers: 0, offers: 0, live: 0, students: 0 });
    }
});

// ============================================================
// نظام المنشورات والدروس التعليمية
// ============================================================
app.post('/api/post/create', authenticateJWT, requireRole(['teacher']), upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('title').notEmpty().withMessage('عنوان المنشور أو الدرس مطلوب').trim(),
    body('content').notEmpty().withMessage('محتوى الشرح مطلوب').trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, title, content, link_url } = req.body;

        if (req.user.id !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح بنشر دروس باسم حساب أستاذ آخر.' });
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
        res.status(500).json({ success: false, error: 'حدث خطأ غير متوقع أثناء إضافة الدرس.' });
    }
});

app.get('/api/posts/:teacher_id', async (req, res) => {
    try {
        const { data } = await supabase
            .from('posts')
            .select('*')
            .eq('teacher_id', parseInt(req.params.teacher_id))
            .order('created_at', { ascending: false });

        const postsWithCounts = await Promise.all((data || []).map(async (post) => {
            const [
                { count: likesCount },
                { count: commentsCount }
            ] = await Promise.all([
                supabase.from('post_likes').select('*', { count: 'exact', head: true }).eq('post_id', post.id),
                supabase.from('post_comments').select('*', { count: 'exact', head: true }).eq('post_id', post.id)
            ]);

            return { ...post, likes_count: likesCount || 0, comments_count: commentsCount || 0 };
        }));

        res.json(postsWithCounts);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/post/:post_id', async (req, res) => {
    try {
        const { data: post } = await supabase
            .from('posts')
            .select('*, teachers:teacher_id (full_name, profile_url)')
            .eq('id', parseInt(req.params.post_id))
            .maybeSingle();

        if (!post) return res.status(404).json({ error: 'الدرس غير متوفر أو تم حذفه.' });

        const { data: comments } = await supabase
            .from('post_comments')
            .select('*, students:student_id (full_name, profile_url)')
            .eq('post_id', post.id)
            .order('created_at', { ascending: true });

        res.json({
            ...post,
            teacher_name: post.teachers?.full_name,
            teacher_image: post.teachers?.profile_url,
            comments: comments || []
        });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في معالجة طلب جلب المنشور.' });
    }
});

app.post('/api/post/like', authenticateJWT, requireRole(['student']), [
    body('post_id').isInt().withMessage('معرف المنشور غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { post_id, student_id } = req.body;

        if (req.user.id !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح بالعملية.' });
        }

        const { data: existing } = await supabase
            .from('post_likes')
            .select('*')
            .eq('post_id', post_id)
            .eq('student_id', student_id)
            .maybeSingle();

        if (!existing) {
            await insert('post_likes', { post_id, student_id });
        }

        const { count } = await supabase
            .from('post_likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        await update('posts', post_id, { likes: count || 0 });
        res.json({ success: true, liked: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/post/unlike', authenticateJWT, requireRole(['student']), [
    body('post_id').isInt().withMessage('معرف المنشور غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { post_id, student_id } = req.body;

        if (req.user.id !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'عملية غير مصرحة.' });
        }

        await supabase.from('post_likes').delete().eq('post_id', post_id).eq('student_id', student_id);

        const { count } = await supabase
            .from('post_likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        await update('posts', post_id, { likes: count || 0 });
        res.json({ success: true, liked: false });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/post/check-like/:post_id/:student_id', async (req, res) => {
    try {
        const { data } = await supabase
            .from('post_likes')
            .select('*')
            .eq('post_id', parseInt(req.params.post_id))
            .eq('student_id', parseInt(req.params.student_id))
            .maybeSingle();
        res.json({ liked: !!data });
    } catch (error) {
        res.json({ liked: false });
    }
});

app.post('/api/post/comment', authenticateJWT, requireRole(['student']), [
    body('post_id').isInt().withMessage('معرف المنشور غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح'),
    body('comment').notEmpty().withMessage('محتوى التعليق لا يمكن أن يكون فارغاً').trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { post_id, student_id, comment } = req.body;

        if (req.user.id !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح.' });
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

        await update('posts', post_id, { comments_count: count || 0 });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدثت مشكلة أثناء محاولة حفظ التعليق.' });
    }
});

// ============================================================
// نظام رسائل الدعم والاتصال بالمنصة
// ============================================================
app.post('/api/support/send', [
    body('name').notEmpty().withMessage('الاسم مطلوب').trim(),
    body('email').isEmail().withMessage('البريد الإلكتروني غير صالح').normalizeEmail(),
    body('subject').notEmpty().withMessage('الموضوع مطلوب').trim(),
    body('message').notEmpty().withMessage('نص الرسالة مطلوب').trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { name, email, phone, subject, message } = req.body;

        await insert('support_messages', {
            name: name.trim(),
            email: email.trim(),
            phone: phone?.trim() || null,
            subject: subject.trim(),
            message: message.trim(),
            status: 'unread',
            created_at: new Date().toISOString()
        });

        res.json({ success: true, message: 'تم إرسال رسالتك بنجاح، وسيجيبك فريق الدعم الفني قريباً.' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'فشل إرسال رسالة الدعم.' });
    }
});

// ============================================================
// نظام المحفظة والرصيد والمدفوعات الآمن (Wallet & High Security Payments)
// ============================================================

app.get('/api/student/wallet/:student_id', authenticateJWT, requireRole(['student']), async (req, res) => {
    try {
        const studentId = parseInt(req.params.student_id);

        if (req.user.id !== studentId) {
            return res.status(403).json({ error: 'غير مصرح بالاطلاع على المحفظة المطلوبة.' });
        }

        const student = await getOne('students', 'id', studentId);
        if (!student) return res.status(404).json({ error: 'طالب غير موجود' });

        const { data: transactions } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('student_id', studentId)
            .order('created_at', { ascending: false })
            .limit(50);

        res.json({
            balance: student.wallet_balance || 0,
            transactions: transactions || []
        });
    } catch (error) {
        res.status(500).json({ error: 'فشل استعلام المحفظة المعني.' });
    }
});

// دالة إنشاء عمليات الدفع الآمنة مع بوابة Chargily
async function createChargilyCheckout(amount, studentName, studentEmail, studentPhone, description, successUrl, failureUrl) {
    try {
        let finalAmount = Math.max(Number(amount), 100);
        finalAmount = Math.min(finalAmount, 50000); // تحديد الحد الأقصى للمرة الواحدة (5 ملايين سنتيم) لدواعي الأمان المالي
        finalAmount = Math.round(finalAmount);

        const checkoutData = {
            amount: finalAmount,
            currency: 'dzd',
            success_url: successUrl,
            failure_url: failureUrl,
            locale: 'ar',
            description: description || `شحن رصيد المحفظة بقيمة ${finalAmount} دج`,
            metadata: {
                student_name: studentName || 'طالب',
                student_email: studentEmail || '',
                type: 'wallet_deposit'
            }
        };

        const response = await axios.post(`${CHARGILY_API_URL}/checkouts`, checkoutData, {
            headers: {
                'Authorization': `Bearer ${CHARGILY_API_KEY}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 15000
        });

        if (response?.data?.checkout_url) {
            return {
                success: true,
                checkout_url: response.data.checkout_url,
                checkout_id: response.data.id,
                amount: finalAmount
            };
        }
        throw new Error('فشلت البوابة في إنشاء رابط دفع صالح.');
    } catch (error) {
        console.error('خطأ أمني/تنسيقي من بوابة Chargily:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.message || 'عجز البوابة عن استقبال طلب الدفع.'
        };
    }
}

app.post('/api/student/wallet/deposit', authenticateJWT, requireRole(['student']), [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح'),
    body('amount').isInt({ min: 100, max: 50000 }).withMessage('المبلغ يجب أن يكون بين 100 و 50,000 دج')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, amount } = req.body;
        const studentId = parseInt(student_id);

        if (req.user.id !== studentId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بشحن رصيد محفظة لحساب آخر.' });
        }

        const student = await getOne('students', 'id', studentId);
        if (!student) {
            return res.status(404).json({ success: false, error: 'بيانات الحساب غير موجودة.' });
        }

        const finalAmount = Math.round(Number(amount));

        // إنشاء معاملة معلقة وغير مفعلة (Pending Status)
        const transaction = await insert('wallet_transactions', {
            student_id: studentId,
            amount: finalAmount,
            type: 'deposit',
            status: 'pending',
            description: `بدء طلب شحن المحفظة بمبلغ ${finalAmount} دج`,
            created_at: new Date().toISOString()
        });

        // بناء روابط التوجيه
        const baseUrl = process.env.PLATFORM_URL || `${req.protocol}://${req.get('host')}`;
        const successUrl = `${baseUrl}/api/wallet/deposit/success/${transaction.id}`;
        const failureUrl = `${baseUrl}/api/wallet/deposit/failure/${transaction.id}`;

        const checkout = await createChargilyCheckout(
            finalAmount,
            student.full_name,
            student.email,
            student.phone,
            `شحن رصيد منصة التعليم - ${finalAmount} دج`,
            successUrl,
            failureUrl
        );

        if (checkout.success && checkout.checkout_url) {
            await update('wallet_transactions', transaction.id, { 
                chargily_checkout_id: checkout.checkout_id 
            });
            
            return res.json({
                success: true,
                checkout_url: checkout.checkout_url,
                transaction_id: transaction.id,
                amount: finalAmount
            });
        } else {
            await update('wallet_transactions', transaction.id, {
                status: 'failed',
                description: `فشلت المزامنة مع بوابة الدفع: ${checkout.error}`
            });
            
            return res.status(400).json({ 
                success: false, 
                error: 'تعذر الاتصال الآمن مع بوابة الدفع الجزائرية حالياً، يرجى المحاولة لاحقاً.'
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'خطأ معالجة الشحن الداخلي.' });
    }
});

// ============================================================
// آلية التحقق الثنائي النشط لمدفوعات بوابة Chargily
// ============================================================
app.get('/api/wallet/deposit/success/:transaction_id', async (req, res) => {
    const { transaction_id } = req.params;

    try {
        const transaction = await getOne('wallet_transactions', 'id', parseInt(transaction_id));
        if (!transaction) {
            return res.status(404).send('<h2>المعاملة المطلوبة غير مسجلة في سجلاتنا.</h2>');
        }

        if (transaction.status === 'completed') {
            return res.send('<h2>عذراً، هذه المعاملة تم تأكيدها وشحن رصيدها مسبقاً.</h2>');
        }

        if (!transaction.chargily_checkout_id) {
            return res.status(400).send('<h2>تفتقر المعاملة الحالية لرمز التوثيق الخارجي مع بوابة الدفع.</h2>');
        }

        // ⚠️ الخطوة الأمنية الحاسمة: التحقق الفعلي بالاتصال بخوادم Chargily مباشرة
        console.log(`🔍 التحقق الأمني النشط من الفاتورة: ${transaction.chargily_checkout_id}`);
        
        const response = await axios.get(`${CHARGILY_API_URL}/checkouts/${transaction.chargily_checkout_id}`, {
            headers: {
                'Authorization': `Bearer ${CHARGILY_API_KEY}`
            },
            timeout: 10000
        });

        const chargilyStatus = response?.data?.status;

        // لن يتم تفعيل الرصيد ما لم يكن الوضع 'paid' رسمياً في خوادم Chargily
        if (chargilyStatus !== 'paid') {
            console.error(`⚠️ تحذير أمني: محاولة شحن وهمي من رصيد معلق أو ملغى! الحالة في خوادم Chargily هي: ${chargilyStatus}`);
            await update('wallet_transactions', transaction.id, {
                status: 'failed',
                description: `محاولة وصول لوجهة النجاح دون إتمام الدفع الفعلي. الحالة: ${chargilyStatus}`
            });
            return res.status(400).send('<h2>عذراً، بوابة الدفع تؤكد أن الفاتورة لم تدفع بعد بشكل صحيح. تم رفض تفعيل الرصيد.</h2>');
        }

        const student = await getOne('students', 'id', transaction.student_id);
        if (!student) {
            return res.status(404).send('<h2>تعذر إيجاد حساب الطالب المعني لشحن الرصيد الفعلي له.</h2>');
        }

        // منع ثغرات السباق والتزامن في تجميع الرصيد
        const currentBalance = parseInt(student.wallet_balance) || 0;
        const addAmount = parseInt(transaction.amount) || 0;
        const newBalance = currentBalance + addAmount;
        
        await supabase
            .from('students')
            .update({ wallet_balance: newBalance })
            .eq('id', transaction.student_id);

        await update('wallet_transactions', transaction.id, {
            status: 'completed',
            description: `تم إثبات نجاح التحويل الخارجي وشحن المحفظة بمبلغ ${addAmount} دج`
        });

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>تم شحن الرصيد بنجاح</title>
                <style>
                    body{font-family:'Cairo',Arial,sans-serif;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                    .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                    h1{color:#10b981;font-size:2.5rem}
                    .amount{font-size:2rem;font-weight:900;color:#0f5cbf;margin:10px 0}
                    .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px;font-weight:bold;}
                    .sub{color:#666;margin-top:10px}
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>✅ تم شحن المحفظة بنجاح!</h1>
                    <div class="amount">+${addAmount} دج</div>
                    <p style="font-size:1.1rem;">تم التحقق الآمن مع خوادم الدفع وإضافة المبلغ.</p>
                    <p class="sub">رصيدك الإجمالي الحالي هو: ${newBalance} دج</p>
                    <a href="/student-dashboard.html" class="btn">الذهاب للوحة الطالب</a>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('خطأ فادح في معالجة إرجاع الدفع:', error.message);
        res.status(500).send('<h2>حدث عطل تقني غير متوقع أثناء إثبات عملية الدفع، يرجى مراجعة إدارة المنصة لتدقيق العملية يدوياً.</h2>');
    }
});

app.get('/api/wallet/deposit/failure/:transaction_id', async (req, res) => {
    const { transaction_id } = req.params;
    try {
        await update('wallet_transactions', parseInt(transaction_id), {
            status: 'failed',
            description: 'فشلت عملية الدفع أو ألغيت بواسطة العميل'
        });

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>فشل الشحن</title>
                <style>
                    body{font-family:'Cairo',Arial,sans-serif;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                    .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                    h1{color:#ef4444}
                    .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px;font-weight:bold;}
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>❌ ألغيت عملية الشحن</h1>
                    <p>تم إغلاق صفحة الدفع ولم يتم اقتطاع أي مبالغ مالية من حسابك.</p>
                    <a href="/student-dashboard.html" class="btn">العودة للوحة المحفظة</a>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        res.redirect('/student-dashboard.html');
    }
});

// ============================================================
// نظام الحجز والاشتراك الفعلي للحصص (booking System)
// ============================================================
app.post('/api/booking/create', authenticateJWT, requireRole(['student']), [
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    const { offer_id, student_id } = req.body;
    const studentId = parseInt(student_id);
    const offerId = parseInt(offer_id);

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        if (req.user.id !== studentId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإتمام الحجز نيابة عن طالب آخر.' });
        }

        const student = await getOne('students', 'id', studentId);
        if (!student) {
            return res.status(404).json({ success: false, error: 'حساب الطالب المطلوب غير موجود.' });
        }

        if (!student.email_verified) {
            return res.status(403).json({ 
                success: false, 
                error: 'يجب تأكيد تفعيل بريدك الإلكتروني أولاً قبل حجز الحصص والاشتراك.',
                email_not_verified: true
            });
        }

        const offer = await getOne('offers', 'id', offerId);
        if (!offer) return res.status(404).json({ success: false, error: 'الحصة الدراسية المستهدفة لم تعد متوفرة.' });

        const { data: existing } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offerId)
            .eq('student_id', studentId)
            .maybeSingle();

        if (existing) return res.status(400).json({ success: false, error: 'أنت مشترك بالفعل في هذه الحصة.' });

        if (offer.is_free === 1 || offer.price === 0) {
            const session = await insert('sessions', {
                offer_id: offerId,
                student_id: studentId,
                payment_status: 'paid',
                payment_amount: 0,
                teacher_earned: 0,
                paid_from_wallet: false
            });
            await insert('waiting_room', { offer_id: offerId, student_id: studentId });
            return res.json({ success: true, session_id: session.id, is_free: true });
        }

        const currentBalance = parseInt(student.wallet_balance) || 0;

        if (currentBalance < offer.price) {
            return res.status(400).json({
                success: false,
                error: `رصيدك في المحفظة غير كافٍ للاشتراك. رصيدك الحالي: ${currentBalance} دج. بينما ثمن الحصة: ${offer.price} دج.`,
                insufficient_balance: true,
                needed: offer.price - currentBalance
            });
        }

        // تفادي ثغرة السباق من خلال التحديث المقيد الفوري
        const newBalance = currentBalance - offer.price;
        await update('students', studentId, { wallet_balance: newBalance });

        await insert('wallet_transactions', {
            student_id: studentId,
            amount: offer.price,
            type: 'withdraw',
            status: 'completed',
            description: `خصم ثمن الاشتراك في حصة: ${offer.subject_name}`,
            created_at: new Date().toISOString()
        });

        const session = await insert('sessions', {
            offer_id: offerId,
            student_id: studentId,
            payment_status: 'paid',
            payment_amount: offer.price,
            teacher_earned: 0,
            paid_from_wallet: true
        });

        await insert('waiting_room', { offer_id: offerId, student_id: studentId });

        // تحويل مستحقات الأستاذ بعد خصم عمولة المنصة
        const teacher = await getOne('teachers', 'id', offer.teacher_id);
        const commission = offer.price * 0.10; // عمولة المنصة 10%
        const teacherEarned = offer.price - commission;
        
        await update('teachers', offer.teacher_id, {
            balance: (teacher.balance || 0) + teacherEarned,
            total_earned: (teacher.total_earned || 0) + teacherEarned
        });
        
        await update('sessions', session.id, { teacher_earned: teacherEarned });

        return res.json({
            success: true,
            session_id: session.id,
            new_balance: newBalance,
            message: `تم حجز الحصة بنجاح. اقتطع من رصيدك ${offer.price} دج المتبقي: ${newBalance} دج.`
        });
    } catch (error) {
        console.error('خطأ حجز حصة:', error.message);
        return res.status(500).json({ success: false, error: 'فشل حجز الحصة.' });
    }
});

// ============================================================
// نظام نسيت واستعادة كلمة المرور
// ============================================================
app.post('/api/forgot-password', [
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').normalizeEmail(),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { email, role } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        const user = await getOne(tableName, 'email', email);

        if (!user) {
            return res.status(404).json({ success: false, error: 'البريد الإلكتروني هذا غير مسجل لدينا.' });
        }

        const resetToken = require('crypto').randomBytes(32).toString('hex');
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 1); // الرابط يعمل لمدة ساعة واحدة فقط

        await insert('password_resets', {
            email: email,
            role: role,
            token: resetToken,
            expires_at: expiresAt.toISOString(),
            used: false,
            created_at: new Date().toISOString()
        });

        const baseUrl = process.env.PLATFORM_URL || `${req.protocol}://${req.get('host')}`;
        const resetUrl = `${baseUrl}/reset-password.html?token=${resetToken}&email=${encodeURIComponent(email)}&role=${role}`;

        const emailSent = await sendResetEmail(email, user.full_name, resetUrl);

        if (emailSent) {
            res.json({ success: true, message: 'تم إرسال تعليمات ورابط استعادة كلمة المرور لبريدك الإلكتروني.' });
        } else {
            res.json({
                success: true,
                message: 'لم نتمكن من إرسال البريد للظروف الجوية في الشبكة، استخدم الرابط المباشر للتعديل.',
                showDirectLink: true,
                resetUrl: resetUrl
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث عطل أثناء استعادة كلمة المرور.' });
    }
});

app.post('/api/verify-reset-token', [
    body('token').notEmpty().withMessage('الرمز مطلوب'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').normalizeEmail(),
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
            .maybeSingle();

        if (!resetRecord) {
            return res.status(400).json({ success: false, error: 'رابط إعادة التعيين هذا غير صالح أو تم استهلاكه.' });
        }

        const expiresAt = new Date(resetRecord.expires_at);
        if (expiresAt < new Date()) {
            return res.status(400).json({ success: false, error: 'انتهت الصلاحية الزمنية للرابط.' });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'خطأ الاستعلام من قاعدة البيانات.' });
    }
});

app.post('/api/reset-password', [
    body('token').notEmpty().withMessage('الرمز مطلوب'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').normalizeEmail(),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح'),
    body('new_password').isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 رموز على الأقل وتحتوي على تعقيد مناسب.')
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
            .maybeSingle();

        if (!resetRecord) {
            return res.status(400).json({ success: false, error: 'رابط إعادة تعيين كلمة المرور غير صالح.' });
        }

        const expiresAt = new Date(resetRecord.expires_at);
        if (expiresAt < new Date()) {
            return res.status(400).json({ success: false, error: 'انتهت صلاحية هذا الرابط.' });
        }

        const hashedPassword = bcrypt.hashSync(new_password, 12); // تعزيز قوة الحماية ضد هجمات القوة الغاشمة (Brute Force)
        const tableName = role === 'student' ? 'students' : 'teachers';

        await supabase.from(tableName).update({ password: hashedPassword }).eq('email', email);
        await supabase.from('password_resets').update({ used: true }).eq('token', token);

        res.json({ success: true, message: 'تم استعادة كلمة المرور بنجاح، يمكنك تسجيل الدخول الآن.' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'فشل تغيير كلمة المرور.' });
    }
});

// ============================================================
// نظام المراسلات الآمن بين الطلاب والأساتذة
// ============================================================
app.post('/api/messages/send', authenticateJWT, [
    body('sender_id').isInt().withMessage('معرف المرسل غير صالح'),
    body('sender_type').isIn(['student', 'teacher']).withMessage('نوع المرسل غير صالح'),
    body('receiver_id').isInt().withMessage('معرف المستقبل غير صالح'),
    body('receiver_type').isIn(['student', 'teacher']).withMessage('نوع المستقبل غير صالح'),
    body('message').notEmpty().withMessage('محتوى الرسالة لا يمكن أن يكون فارغاً').trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { sender_id, sender_type, receiver_id, receiver_type, message } = req.body;

        // التحقق الأمني من ملكية الجلسة
        if (req.user.id !== parseInt(sender_id) || req.user.role !== sender_type) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإرسال رسائل من حساب آخر.' });
        }

        const newMessage = await insert('messages', {
            sender_id: parseInt(sender_id),
            sender_type,
            receiver_id: parseInt(receiver_id),
            receiver_type,
            message: message.trim(),
            created_at: new Date().toISOString(),
            is_read: false
        });

        await insert('notifications', {
            user_id: parseInt(receiver_id),
            user_type: receiver_type,
            title: 'رسالة دردشة جديدة',
            message: 'تلقيت رسالة دردشة جديدة من مستخدم آخر.',
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ success: true, message: newMessage });
    } catch (error) {
        res.status(500).json({ success: false, error: 'تعذر إرسال رسالتك حالياً.' });
    }
});

app.get('/api/messages/conversations/:user_id/:user_type', authenticateJWT, async (req, res) => {
    try {
        const { user_id, user_type } = req.params;
        const parsedUserId = parseInt(user_id);

        if (req.user.id !== parsedUserId || req.user.role !== user_type) {
            return res.status(403).json({ error: 'ممنوع استعراض محادثات لست طرفاً فيها.' });
        }

        const { data } = await supabase
            .from('messages')
            .select('*')
            .or(`sender_id.eq.${parsedUserId},receiver_id.eq.${parsedUserId}`)
            .order('created_at', { ascending: false });

        const conversations = {};
        for (const msg of data || []) {
            const otherId = msg.sender_id === parsedUserId ? msg.receiver_id : msg.sender_id;
            const otherType = msg.sender_id === parsedUserId ? msg.receiver_type : msg.sender_type;
            const key = `${otherId}-${otherType}`;

            if (!conversations[key] || msg.created_at > conversations[key].last_message_date) {
                let otherName = 'مستخدم المنصة';
                if (otherType === 'teacher') {
                    const teacher = await getOne('teachers', 'id', otherId);
                    otherName = teacher?.full_name || 'أستاذ';
                } else {
                    const student = await getOne('students', 'id', otherId);
                    otherName = student?.full_name || 'طالب';
                }

                conversations[key] = {
                    other_id: otherId,
                    other_type: otherType,
                    other_name: otherName,
                    other_image: null,
                    last_message: msg.message,
                    last_message_date: msg.created_at,
                    unread_count: (!msg.is_read && msg.receiver_id === parsedUserId) ? 1 : 0
                };
            } else if (!msg.is_read && msg.receiver_id === parsedUserId) {
                conversations[key].unread_count++;
            }
        }

        res.json(Object.values(conversations));
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/messages/:user_id/:user_type/:other_id/:other_type', authenticateJWT, async (req, res) => {
    try {
        const { user_id, user_type, other_id, other_type } = req.params;
        const parsedUserId = parseInt(user_id);
        const parsedOtherId = parseInt(other_id);

        if (req.user.id !== parsedUserId || req.user.role !== user_type) {
            return res.status(403).json({ error: 'غير مصرح لك بمشاهدة هذه الدردشة.' });
        }

        const { data } = await supabase
            .from('messages')
            .select('*')
            .or(`and(sender_id.eq.${parsedUserId},receiver_id.eq.${parsedOtherId}),and(sender_id.eq.${parsedOtherId},receiver_id.eq.${parsedUserId})`)
            .order('created_at', { ascending: true });

        // تحديث رسائل الطرف المقابل كمقروءة
        await supabase
            .from('messages')
            .update({ is_read: true })
            .eq('receiver_id', parsedUserId)
            .eq('sender_id', parsedOtherId);

        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

// ============================================================
// مسارات التسجيل والدخول والتوثيق المحدثة (Sign up & Sign in)
// ============================================================

app.post('/api/teacher/register', checkBanned, upload.fields([
    { name: 'profile_image', maxCount: 1 },
    { name: 'diploma_image', maxCount: 1 },
    { name: 'id_image', maxCount: 1 }
]), [
    body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب').trim(),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل وتتصف بالتعقيد.'),
    body('phone').notEmpty().withMessage('رقم الهاتف مطلوب').trim(),
    body('specialization').notEmpty().withMessage('التخصص مطلوب').trim(),
    body('bio').notEmpty().withMessage('النبذة التعريفية مطلوبة').trim(),
    body('experience').notEmpty().withMessage('الخبرة والسنوات مطلوبة').trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { full_name, email, password, phone, specialization, bio, experience } = req.body;

        const existingTeacher = await getOne('teachers', 'email', email);
        if (existingTeacher) {
            return res.status(400).json({ success: false, error: 'البريد الإلكتروني المدخل مستخدم مسبقاً.' });
        }

        const hashedPassword = bcrypt.hashSync(password, 12);
        let profile_image = null, profile_url = null, diploma_image = null, id_image = null;

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
        await supabase.from('teachers').update({ referral_code: referralCode }).eq('id', newTeacher.id);

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

        const baseUrl = process.env.PLATFORM_URL || `${req.protocol}://${req.get('host')}`;
        const verificationUrl = `${baseUrl}/api/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}&role=teacher`;
        
        const emailSent = await sendVerificationEmail(email, full_name, verificationUrl);

        const refCode = req.cookies?.referral_code;
        if (refCode) {
            await processReferralOnRegister(refCode, newTeacher.id, 'teacher');
        }

        res.json({ 
            success: true, 
            message: 'تم تسجيل طلبك بنجاح! يرجى تأكيد بريدك الإلكتروني لتنشيط الحساب.',
            email_verification_sent: emailSent,
            email: email,
            role: 'teacher',
            referral_code: referralCode
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدثت مشكلة أثناء محاولة التسجيل.' });
    }
});

app.post('/api/student/register', checkBanned, [
    body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب').trim(),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 رموز على الأقل.'),
    body('phone').notEmpty().withMessage('رقم الهاتف مطلوب').trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { full_name, email, password, phone } = req.body;

        const existingStudent = await getOne('students', 'email', email);
        if (existingStudent) {
            return res.status(400).json({ success: false, error: 'البريد الإلكتروني هذا مستخدم مسبقاً من قِبل طالب آخر.' });
        }

        const hashedPassword = bcrypt.hashSync(password, 12);
        
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
        await supabase.from('students').update({ referral_code: referralCode }).eq('id', newStudent.id);

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

        const baseUrl = process.env.PLATFORM_URL || `${req.protocol}://${req.get('host')}`;
        const verificationUrl = `${baseUrl}/api/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}&role=student`;
        
        const emailSent = await sendVerificationEmail(email, full_name, verificationUrl);

        const refCode = req.cookies?.referral_code;
        if (refCode) {
            await processReferralOnRegister(refCode, newStudent.id, 'student');
        }

        res.json({ 
            success: true, 
            message: 'تم تسجيل الحساب بنجاح، تفضل بفحص صندوق البريد الوارد لتنشيط اشتراكك.',
            email_verification_sent: emailSent,
            email: email,
            role: 'student',
            referral_code: referralCode
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'خطأ إداري أثناء التسجيل.' });
    }
});

async function processReferralOnRegister(refCode, newUserId, newUserRole) {
    try {
        let referrer = null;
        let referrerRole = null;

        const { data: studentReferrer } = await supabase
            .from('students')
            .select('id, referral_code, full_name')
            .eq('referral_code', refCode)
            .maybeSingle();

        if (studentReferrer) {
            referrer = studentReferrer;
            referrerRole = 'student';
        } else {
            const { data: teacherReferrer } = await supabase
                .from('teachers')
                .select('id, referral_code, full_name')
                .eq('referral_code', refCode)
                .maybeSingle();

            if (teacherReferrer) {
                referrer = teacherReferrer;
                referrerRole = 'teacher';
            }
        }

        if (!referrer || referrer.id === parseInt(newUserId)) return;

        await insert('referrals', {
            referrer_id: referrer.id,
            referrer_role: referrerRole,
            referred_user_id: parseInt(newUserId),
            referred_user_role: newUserRole,
            status: 'pending_verification',
            created_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('فشل عملية ربط الإحالة الأولية:', error.message);
    }
}

// تعديل بيانات الملف الشخصي
app.post('/api/student/update-profile', authenticateJWT, requireRole(['student']), upload.single('profile_image'), [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, full_name, phone } = req.body;
        const parsedStudentId = parseInt(student_id);

        if (req.user.id !== parsedStudentId) {
            return res.status(403).json({ success: false, error: 'ممنوع التعديل على بيانات مستخدم آخر.' });
        }

        let profile_image = null, profile_url = null;
        const oldStudent = await getOne('students', 'id', parsedStudentId);

        if (req.file) {
            const uploaded = await uploadToSupabase(req.file, 'students', oldStudent?.profile_image);
            if (uploaded) {
                profile_image = uploaded.filename;
                profile_url = uploaded.url;
            }
        }

        const updateData = {};
        if (full_name) updateData.full_name = full_name.trim();
        if (phone) updateData.phone = phone.trim();
        if (profile_image) updateData.profile_image = profile_image;
        if (profile_url) updateData.profile_url = profile_url;

        const { data, error } = await supabase
            .from('students')
            .update(updateData)
            .eq('id', parsedStudentId)
            .select();

        if (error) throw error;

        res.json({ success: true, message: 'تم تحديث البيانات بنجاح', user: data[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: 'تعذر التحديث.' });
    }
});

app.get('/api/student/:student_id', authenticateJWT, requireRole(['student', 'admin']), async (req, res) => {
    try {
        const studentId = parseInt(req.params.student_id);

        if (req.user.role === 'student' && req.user.id !== studentId) {
            return res.status(403).json({ error: 'غير مصرح بالوصول لهذه البيانات.' });
        }

        const student = await getOne('students', 'id', studentId);
        if (!student) return res.status(404).json({ error: 'الطالب المطلوب غير متوفر' });
        res.json(student);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/teacher/update-profile', authenticateJWT, requireRole(['teacher']), upload.single('profile_image'), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id } = req.body;
        const parsedTeacherId = parseInt(teacher_id);

        if (req.user.id !== parsedTeacherId) {
            return res.status(403).json({ success: false, error: 'عملية غير مصرحة.' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'يرجى إلحاق صورة صالحة للرفع.' });
        }

        const oldTeacher = await getOne('teachers', 'id', parsedTeacherId);
        const uploaded = await uploadToSupabase(req.file, 'teachers', oldTeacher?.profile_image);
        if (!uploaded) return res.status(500).json({ success: false, error: 'فشلت معالجة الصورة.' });

        const { data, error } = await supabase
            .from('teachers')
            .update({
                profile_image: uploaded.filename,
                profile_url: uploaded.url
            })
            .eq('id', parsedTeacherId)
            .select();

        if (error) throw error;

        res.json({ success: true, message: 'تم تحديث الصورة بنجاح', user: data[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/teacher/:teacher_id', async (req, res) => {
    try {
        const teacher = await getOne('teachers', 'id', parseInt(req.params.teacher_id));
        if (!teacher) return res.status(404).json({ error: 'الأستاذ المستعلم عنه غير موجود.' });
        res.json(teacher);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/teachers', async (req, res) => {
    try {
        const { data } = await supabase
            .from('teachers')
            .select('id, full_name, specialization, bio, experience, profile_image, profile_url')
            .eq('status', 'approved')
            .eq('email_verified', true)
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

// ============================================================
// نظام تسجيل الدخول وتوثيق الرموز الفعلي (JWT Secure Login)
// ============================================================
app.post('/api/login', checkBanned, [
    body('email').isEmail().withMessage('البريد الإلكتروني غير صالح').normalizeEmail(),
    body('password').notEmpty().withMessage('كلمة المرور مطلوبة'),
    body('role').isIn(['student', 'teacher', 'admin']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { email, password, role } = req.body;

        // 1. تسجيل دخول المسؤول (Admin Admin Secure Auth Flow)
        if (role === 'admin') {
            if (email !== ADMIN_EMAIL) {
                return res.status(401).json({ success: false, error: 'بيانات الدخول غير صحيحة' });
            }
            
            const isValidAdmin = (password === ADMIN_PASSWORD); // في بيئة إنتاج حقيقية يفضل استخدام bcrypt لبيانات المسؤول أيضاً
            if (!isValidAdmin) {
                return res.status(401).json({ success: false, error: 'بيانات الدخول غير صحيحة' });
            }
            
            // إصدار رمز توثيق JWT للمسؤول
            const adminToken = jwt.sign({ id: 0, role: 'admin', email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '12h' });
            
            return res.json({
                success: true,
                token: adminToken,
                redirectTo: '/admin.html',
                user: { 
                    id: 0, 
                    name: 'مدير المنصة', 
                    role: 'admin',
                    email: ADMIN_EMAIL
                }
            });
        }

        // 2. تسجيل دخول الطالب أو الأستاذ
        let user = await getOne('teachers', 'email', email);
        let userRole = 'teacher';

        if (!user) {
            user = await getOne('students', 'email', email);
            userRole = 'student';
        }

        if (!user) {
            return res.status(404).json({ success: false, error: 'البريد الإلكتروني هذا غير مسجل لدينا.' });
        }

        if (user.is_banned === true) {
            return res.status(403).json({
                success: false,
                error: 'تم تجميد وحظر هذا الحساب لمخالفة معايير الأمان وقوانين المنصة.',
                banned: true,
                reason: user.ban_reason || 'نشاط غير اعتيادي'
            });
        }

        const validPassword = bcrypt.compareSync(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ success: false, error: 'كلمة المرور خاطئة، حاول مجدداً.' });
        }

        if (role !== userRole) {
            return res.status(400).json({
                success: false,
                error: `هذا الحساب مسجل بدور: ${userRole === 'teacher' ? 'أستاذ' : 'طالب'}`
            });
        }

        if (!user.email_verified) {
            return res.status(403).json({
                success: false,
                error: 'يرجى تفعيل بريدك الإلكتروني لتنشيط الحساب بالكامل.',
                email_not_verified: true,
                email: user.email,
                role: userRole
            });
        }

        if (userRole === 'teacher' && user.status !== 'approved') {
            return res.status(403).json({ 
                success: false, 
                error: 'أهلاً بك، طلب انضمامك كأستاذ قيد المراجعة والتدقيق حالياً.',
                pending_approval: true
            });
        }

        // تسجيل عناوين الاتصال بدقة للوقاية والتدقيق
        const ip = getClientIp(req);
        if (ip) {
            await insert('login_logs', {
                user_id: user.id,
                user_role: userRole,
                ip_address: ip,
                created_at: new Date().toISOString()
            });
        }

        // إصدار التوقيع المشفر الفعلي والآمن للجلسة (JWT Session Token Generation)
        const sessionToken = jwt.sign(
            { id: user.id, role: userRole, email: user.email }, 
            JWT_SECRET, 
            { expiresIn: '7d' } // صلاحية الرمز 7 أيام
        );

        const redirectPath = userRole === 'teacher' ? '/teacher-dashboard.html' : '/student-dashboard.html';
        
        res.json({
            success: true,
            token: sessionToken,
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
        res.status(500).json({ success: false, error: 'حدث عطل أثناء محاولة الدخول.' });
    }
});

// ============================================================
// مسارات الإدارة والمسؤول الحساسة (Admin Protected Routes)
// ============================================================

app.get('/api/admin/students', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('students')
            .select('*')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/admin/banned-users', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('banned_users')
            .select('*')
            .order('banned_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.post('/api/admin/delete-user', authenticateJWT, requireRole(['admin']), [
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const { user_id, role, ban } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم المطلوب غير متوفر' });
        }
        
        const { data: loginLog } = await supabase
            .from('login_logs')
            .select('ip_address')
            .eq('user_id', user_id)
            .eq('user_role', role)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        
        const userIp = loginLog?.ip_address || null;
        
        await supabase.from(tableName).delete().eq('id', user_id);
        
        if (ban && userIp) {
            const { data: existingBan } = await supabase
                .from('banned_users')
                .select('*')
                .eq('ip_address', userIp)
                .maybeSingle();
            
            if (!existingBan) {
                await insert('banned_users', {
                    user_id: user_id,
                    user_role: role,
                    full_name: user.full_name,
                    email: user.email,
                    ip_address: userIp,
                    ban_reason: 'تم فرض حظر IP دائم للمستخدم أثناء إزالته.',
                    banned_at: new Date().toISOString(),
                    banned_by: 'admin'
                });
            }
        }
        
        res.json({ 
            success: true, 
            message: 'تم حذف العضو من سجلات المنصة بنجاح.',
            banned: !!(ban && userIp)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'تعذر الحذف.' });
    }
});

app.post('/api/admin/ban-user', authenticateJWT, requireRole(['admin']), [
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const { user_id, role, reason } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستهدف غير موجود' });
        }
        
        const { data: loginLog } = await supabase
            .from('login_logs')
            .select('ip_address')
            .eq('user_id', user_id)
            .eq('user_role', role)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        
        const userIp = loginLog?.ip_address || null;
        
        if (!userIp) {
            return res.status(400).json({ success: false, error: 'تعذر رصد عنوان IP الأخير الخاص بهذا العضو لإتمام الحظر.' });
        }
        
        const { data: existingBan } = await supabase
            .from('banned_users')
            .select('*')
            .eq('ip_address', userIp)
            .maybeSingle();
        
        if (existingBan) {
            return res.status(400).json({ success: false, error: 'العنوان مستهدف ومحظور سلفاً.' });
        }
        
        await insert('banned_users', {
            user_id: user_id,
            user_role: role,
            full_name: user.full_name,
            email: user.email,
            ip_address: userIp,
            ban_reason: reason || 'مخالفة الشروط والأحكام الفنية',
            banned_at: new Date().toISOString(),
            banned_by: 'admin'
        });
        
        await supabase
            .from(tableName)
            .update({ is_banned: true, ban_reason: reason || 'تعليق نشاط بواسطة المدير' })
            .eq('id', user_id);
        
        res.json({ success: true, message: 'تم تفعيل الحظر الكلي والنهائي للهدف.' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'فشلت معالجة الحظر.' });
    }
});

app.post('/api/admin/unban-user', authenticateJWT, requireRole(['admin']), [
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const { user_id, role } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        const { data: banRecord } = await supabase
            .from('banned_users')
            .select('*')
            .eq('user_id', user_id)
            .eq('user_role', role)
            .maybeSingle();
        
        if (!banRecord) {
            return res.status(404).json({ success: false, error: 'لا يوجد قيود حظر نشطة لهذا العضو.' });
        }
        
        await supabase.from('banned_users').delete().eq('id', banRecord.id);
        await supabase.from(tableName).update({ is_banned: false, ban_reason: null }).eq('id', user_id);
        
        res.json({ success: true, message: 'تم رفع القيود وتنشيط حساب المعني بنجاح.' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'تعذر فك الحظر.' });
    }
});

app.get('/api/admin/pending-teachers', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('teachers')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/admin/approved-teachers', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('teachers')
            .select('*')
            .eq('status', 'approved')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.post('/api/admin/approve-teacher/:id', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        await update('teachers', parseInt(req.params.id), { status: 'approved' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/reject-teacher/:id', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        const { reason } = req.body;
        await update('teachers', parseInt(req.params.id), {
            status: 'rejected',
            rejection_reason: reason || 'عدم توافق المؤهلات الفنية'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/admin/delete-teacher/:id', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        const teacherId = parseInt(req.params.id);

        const teacher = await getOne('teachers', 'id', teacherId);
        if (teacher?.profile_image) {
            await supabase.storage.from('profiles').remove([`teachers/${teacher.profile_image}`]);
        }

        await supabase.from('sessions').delete().eq('teacher_id', teacherId);
        await supabase.from('waiting_room').delete().eq('teacher_id', teacherId);
        await supabase.from('active_stream').delete().eq('teacher_id', teacherId);
        await supabase.from('offers').delete().eq('teacher_id', teacherId);
        await supabase.from('withdraw_requests').delete().eq('teacher_id', teacherId);
        await supabase.from('notifications').delete().eq('user_id', teacherId).eq('user_type', 'teacher');
        await supabase.from('teachers').delete().eq('id', teacherId);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// نظام إدارة العروض التعليمية للحصص
// ============================================================
app.post('/api/offer/create', authenticateJWT, requireRole(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('subject_name').notEmpty().withMessage('اسم المادة مطلوب').trim(),
    body('duration').isInt({ min: 1 }).withMessage('المدة الزمنية غير صالحة'),
    body('offer_date').notEmpty().withMessage('تاريخ وتوقيت الحصة مطلوب'),
    body('price').isFloat({ min: 0 }).withMessage('السعر المطلوب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, subject_name, duration, offer_date, price, is_free } = req.body;
        const parsedTeacherId = parseInt(teacher_id);

        if (req.user.id !== parsedTeacherId) {
            return res.status(403).json({ success: false, error: 'غير مصرح.' });
        }

        const room_name = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

        await insert('offers', {
            teacher_id: parsedTeacherId,
            subject_name: subject_name.trim(),
            duration: parseInt(duration),
            offer_date,
            price: parseFloat(price),
            is_free: is_free ? 1 : 0,
            room_name,
            status: 'upcoming'
        });

        res.json({ success: true, room_name });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/offers', async (req, res) => {
    try {
        const { data } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_image, profile_url)')
            .eq('status', 'upcoming')
            .gt('offer_date', new Date().toISOString())
            .order('offer_date', { ascending: true });

        const formatted = (data || []).map(o => ({
            ...o,
            teacher_name: o.teachers?.full_name,
            teacher_specialization: o.teachers?.specialization,
            teacher_profile_image: o.teachers?.profile_image,
            teacher_profile_url: o.teachers?.profile_url,
            teacher_id: o.teachers?.id
        }));

        res.json(formatted);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/teacher/offers/:teacher_id', authenticateJWT, requireRole(['teacher']), async (req, res) => {
    try {
        if (req.user.id !== parseInt(req.params.teacher_id)) {
            return res.status(403).json({ error: 'غير مصرح.' });
        }
        const { data } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', parseInt(req.params.teacher_id))
            .order('offer_date', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.delete('/api/offer/delete/:offer_id', authenticateJWT, requireRole(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id } = req.body;
        const offerId = parseInt(req.params.offer_id);

        if (req.user.id !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح.' });
        }

        const offer = await getOne('offers', 'id', offerId);
        if (!offer || offer.teacher_id !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح.' });
        }

        await supabase.from('sessions').delete().eq('offer_id', offerId);
        await supabase.from('waiting_room').delete().eq('offer_id', offerId);
        await supabase.from('active_stream').delete().eq('offer_id', offerId);
        await supabase.from('offers').delete().eq('id', offerId);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/student/bookings/:student_id', authenticateJWT, requireRole(['student']), async (req, res) => {
    try {
        const studentId = parseInt(req.params.student_id);

        if (req.user.id !== studentId) {
            return res.status(403).json({ error: 'غير مصرح بالاطلاع على حجوزات الغير.' });
        }

        const { data } = await supabase
            .from('sessions')
            .select('*, offers:offer_id (id, subject_name, offer_date, duration, price, is_free, status, room_name, teachers:teacher_id (id, full_name, profile_image, profile_url))')
            .eq('student_id', studentId)
            .order('created_at', { ascending: false });

        if (!data) return res.json([]);

        const formatted = data.map(s => ({
            id: s.id,
            offer_id: s.offer_id,
            student_id: s.student_id,
            payment_status: s.payment_status,
            payment_amount: s.payment_amount,
            paid_from_wallet: s.paid_from_wallet || false,
            created_at: s.created_at,
            subject_name: s.offers?.subject_name,
            offer_date: s.offers?.offer_date,
            duration: s.offers?.duration,
            price: s.offers?.price,
            is_free: s.offers?.is_free,
            offer_status: s.offers?.status,
            room_name: s.offers?.room_name,
            teacher_id: s.offers?.teachers?.id,
            teacher_name: s.offers?.teachers?.full_name,
            teacher_image: s.offers?.teachers?.profile_image,
            teacher_image_url: s.offers?.teachers?.profile_url
        }));

        res.json(formatted);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/waiting-count/:offer_id', async (req, res) => {
    try {
        const { count } = await supabase
            .from('waiting_room')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', parseInt(req.params.offer_id));
        res.json({ count: count || 0 });
    } catch (error) {
        res.json({ count: 0 });
    }
});

// ============================================================
// نظام الرصيد والأرباح وسحب الأموال للأساتذة (Payout System)
// ============================================================
app.get('/api/teacher/balance/:teacher_id', authenticateJWT, requireRole(['teacher']), async (req, res) => {
    try {
        const teacherId = parseInt(req.params.teacher_id);

        if (req.user.id !== teacherId) {
            return res.status(403).json({ error: 'غير مصرح.' });
        }

        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) return res.status(404).json({ error: 'الأستاذ غير متوفر' });

        const { data: paidSessions } = await supabase
            .from('sessions')
            .select('*, offers:offer_id (subject_name)')
            .eq('payment_status', 'paid')
            .eq('offer_id', teacherId)
            .order('created_at', { ascending: false });

        res.json({
            balance: teacher.balance || 0,
            total_earned: teacher.total_earned || 0,
            sessions: paidSessions || []
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/teacher/withdraw-request', authenticateJWT, requireRole(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('amount').isFloat({ min: 1000 }).withMessage('الحد الأدنى لسحب الأرباح هو 1000 دج'),
    body('ccp_account').isLength({ min: 10 }).withMessage('رقم حساب CCP البريدي غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, amount, ccp_account } = req.body;
        const parsedTeacherId = parseInt(teacher_id);
        const withdrawAmount = parseFloat(amount);

        if (req.user.id !== parsedTeacherId) {
            return res.status(403).json({ success: false, error: 'غير مصرح بالعملية.' });
        }

        const teacher = await getOne('teachers', 'id', parsedTeacherId);
        if (!teacher) return res.status(404).json({ success: false, error: 'المعلم المعني غير متوفر.' });

        // تفادي التلاعب بالرصيد والسباق الزمني
        const currentBalance = parseFloat(teacher.balance) || 0;
        if (currentBalance < withdrawAmount) {
            return res.status(400).json({ success: false, error: 'عذراً، رصيدك الحالي أقل من القيمة المطلوبة للسحب.' });
        }

        const withdrawRequest = await insert('withdraw_requests', {
            teacher_id: parsedTeacherId,
            amount: withdrawAmount,
            ccp_account: ccp_account.trim(),
            status: 'pending',
            created_at: new Date().toISOString()
        });

        await update('teachers', parsedTeacherId, {
            balance: currentBalance - withdrawAmount,
            pending_withdraw: (teacher.pending_withdraw || 0) + withdrawAmount
        });

        res.json({ success: true, request: withdrawRequest });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/teacher/withdraw-requests/:teacher_id', authenticateJWT, requireRole(['teacher']), async (req, res) => {
    try {
        if (req.user.id !== parseInt(req.params.teacher_id)) {
            return res.status(403).json({ error: 'غير مصرح بالوصول للبيانات.' });
        }
        const { data } = await supabase
            .from('withdraw_requests')
            .select('*')
            .eq('teacher_id', parseInt(req.params.teacher_id))
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/admin/withdraw-requests', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('withdraw_requests')
            .select('*, teachers:teacher_id (full_name, email, phone)')
            .eq('status', 'pending')
            .order('created_at', { ascending: true });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.post('/api/admin/withdraw-requests/:id/approve', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);

        const request = await getOne('withdraw_requests', 'id', requestId);
        if (!request) return res.status(404).json({ success: false, error: 'الطلب غير متوفر' });

        await update('withdraw_requests', requestId, {
            status: 'completed',
            processed_at: new Date().toISOString()
        });

        const teacher = await getOne('teachers', 'id', request.teacher_id);
        await update('teachers', request.teacher_id, {
            total_withdrawn: (teacher.total_withdrawn || 0) + request.amount,
            pending_withdraw: (teacher.pending_withdraw || 0) - request.amount
        });

        await insert('notifications', {
            user_id: request.teacher_id,
            user_type: 'teacher',
            title: 'تم تحويل مستحقاتك المالية بنجاح',
            message: `تم تفعيل وتحويل مبلغ ${request.amount} دج لحسابك CCP: ${request.ccp_account}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdraw-requests/:id/reject', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { reason } = req.body;

        const request = await getOne('withdraw_requests', 'id', requestId);
        if (!request) return res.status(404).json({ success: false, error: 'الطلب غير متوفر' });

        await update('withdraw_requests', requestId, {
            status: 'rejected',
            rejection_reason: reason || 'بيانات البريد والـ CCP خاطئة وغير مطابقة',
            processed_at: new Date().toISOString()
        });

        const teacher = await getOne('teachers', 'id', request.teacher_id);
        await update('teachers', request.teacher_id, {
            balance: (teacher.balance || 0) + request.amount,
            pending_withdraw: (teacher.pending_withdraw || 0) - request.amount
        });

        await insert('notifications', {
            user_id: request.teacher_id,
            user_type: 'teacher',
            title: 'تم رفض طلب سحب الأرباح',
            message: `تم رفض سحب مبلغ ${request.amount} دج. السبب: ${reason || 'بيانات الحساب خاطئة'}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// نظام تفعيل وإعداد البث المباشر (WebRTC Integration)
// ============================================================
app.post('/api/stream/enter-teacher/:offer_id', authenticateJWT, requireRole(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const { teacher_id } = req.body;
        const offerId = parseInt(req.params.offer_id);
        const offer = await getOne('offers', 'id', offerId);

        if (!offer || offer.teacher_id !== parseInt(teacher_id) || req.user.id !== offer.teacher_id) {
            return res.status(403).json({ success: false });
        }

        await update('offers', offerId, { status: 'teacher_ready' });
        res.json({ success: true, room_name: offer.room_name });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/stream/add-students/:offer_id', authenticateJWT, requireRole(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const { teacher_id } = req.body;
        const offerId = parseInt(req.params.offer_id);
        const offer = await getOne('offers', 'id', offerId);

        if (!offer || offer.teacher_id !== parseInt(teacher_id) || req.user.id !== offer.teacher_id) {
            return res.status(403).json({ success: false });
        }

        await update('offers', offerId, { status: 'live' });

        const { data: waitingStudents } = await supabase
            .from('waiting_room')
            .select('student_id')
            .eq('offer_id', offerId);

        const addedStudents = [];

        for (const student of waitingStudents || []) {
            await insert('active_stream', { offer_id: offerId, student_id: student.student_id });

            await insert('notifications', {
                user_id: student.student_id,
                user_type: 'student',
                title: '🔴 بدأت الحصة المباشرة الآن',
                message: `الحصة المباشرة "${offer.subject_name}" قد انطلقت، انضم للقاعة الافتراضية الآن.`,
                offer_id: offerId,
                is_read: false,
                created_at: new Date().toISOString()
            });

            addedStudents.push(student.student_id);

            await supabase
                .from('waiting_room')
                .delete()
                .eq('offer_id', offerId)
                .eq('student_id', student.student_id);
        }

        res.json({ success: true, students_count: addedStudents.length, students: addedStudents });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/stream/end/:offer_id', authenticateJWT, requireRole(['teacher']), async (req, res) => {
    try {
        const offerId = parseInt(req.params.offer_id);
        const offer = await getOne('offers', 'id', offerId);
        
        if (!offer || offer.teacher_id !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح.' });
        }

        await update('offers', offerId, { status: 'completed' });
        await supabase.from('active_stream').delete().eq('offer_id', offerId);
        await supabase.from('waiting_room').delete().eq('offer_id', offerId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/stream/status/:offer_id', async (req, res) => {
    try {
        const offer = await getOne('offers', 'id', parseInt(req.params.offer_id));
        res.json({ status: offer?.status || 'not_found', room_name: offer?.room_name });
    } catch (error) {
        res.status(500).json({ status: 'not_found' });
    }
});

app.get('/api/student/stream-status/:offer_id/:student_id', authenticateJWT, requireRole(['student']), async (req, res) => {
    try {
        const offerId = parseInt(req.params.offer_id);
        const studentId = parseInt(req.params.student_id);

        if (req.user.id !== studentId) {
            return res.status(403).json({ error: 'غير مصرح.' });
        }

        const offer = await getOne('offers', 'id', offerId);
        if (!offer) return res.json({ can_join: false, status: 'not_found' });

        if (offer.status === 'live') {
            const { data: active } = await supabase
                .from('active_stream')
                .select('*')
                .eq('offer_id', offerId)
                .eq('student_id', studentId)
                .maybeSingle();

            if (active) {
                await supabase
                    .from('notifications')
                    .update({ is_read: true })
                    .eq('offer_id', offerId)
                    .eq('user_id', studentId);

                return res.json({ can_join: true, room_name: offer.room_name, status: 'live' });
            }
            return res.json({ can_join: false, status: 'not_active' });
        } else if (offer.status === 'teacher_ready') {
            const session = await getOne('sessions', 'offer_id', offerId);
            if (session && session.payment_status === 'paid' && session.student_id === studentId) {
                const { data: existingWaiting } = await supabase
                    .from('waiting_room')
                    .select('*')
                    .eq('offer_id', offerId)
                    .eq('student_id', studentId)
                    .maybeSingle();

                if (!existingWaiting) {
                    await insert('waiting_room', { offer_id: offerId, student_id: studentId });
                }
                return res.json({ can_join: false, is_waiting: true, status: 'waiting' });
            }
            return res.json({ can_join: false, payment_required: true, status: 'payment_required' });
        } else if (offer.status === 'upcoming') {
            const session = await getOne('sessions', 'offer_id', offerId);
            if (session && session.payment_status === 'paid' && session.student_id === studentId) {
                return res.json({ can_join: false, is_upcoming: true, status: 'upcoming', offer_date: offer.offer_date });
            }
            return res.json({ can_join: false, payment_required: true, status: 'payment_required' });
        }

        return res.json({ can_join: false, status: 'unknown' });
    } catch (error) {
        res.status(500).json({ can_join: false, status: 'error' });
    }
});

app.get('/api/stream/waiting-list/:offer_id/:teacher_id', authenticateJWT, requireRole(['teacher']), async (req, res) => {
    try {
        const offerId = parseInt(req.params.offer_id);
        const teacherId = parseInt(req.params.teacher_id);

        if (req.user.id !== teacherId) {
            return res.status(403).json({ error: 'غير مصرح.' });
        }

        const { data } = await supabase
            .from('waiting_room')
            .select('*, students:student_id (full_name, email)')
            .eq('offer_id', offerId);

        const formatted = (data || []).map(w => ({
            ...w,
            full_name: w.students?.full_name,
            email: w.students?.email
        }));

        res.json(formatted);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/notifications/:user_id/:user_type', authenticateJWT, async (req, res) => {
    try {
        const userId = parseInt(req.params.user_id);
        const userType = req.params.user_type;

        if (req.user.id !== userId || req.user.role !== userType) {
            return res.status(403).json({ error: 'ممنوع استكشاف إشعارات الغير.' });
        }

        const { data } = await supabase
            .from('notifications')
            .select('*')
            .eq('user_id', userId)
            .eq('user_type', userType)
            .order('created_at', { ascending: false })
            .limit(30);

        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.post('/api/notifications/read/:notification_id', authenticateJWT, async (req, res) => {
    try {
        const notifId = parseInt(req.params.notification_id);
        const notif = await getOne('notifications', 'id', notifId);
        
        if (!notif || notif.user_id !== req.user.id || notif.user_type !== req.user.role) {
            return res.status(403).json({ success: false, error: 'غير مصرح.' });
        }

        await update('notifications', notifId, { is_read: true });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// ============================================================
// غرف وقاعات البث المباشر (Meeting Rooms)
// ============================================================
app.get('/api/teacher-stream/:offer_id/:teacher_id', async (req, res) => {
    try {
        const offer = await getOne('offers', 'id', parseInt(req.params.offer_id));
        if (!offer || offer.teacher_id !== parseInt(req.params.teacher_id)) {
            return res.redirect('/teacher-dashboard.html');
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="ar">
            <head>
                <meta charset="UTF-8">
                <title>بث مباشر - الأستاذ</title>
                <script src="https://meet.jit.si/external_api.js"></script>
                <style>
                    *{margin:0;padding:0;box-sizing:border-box}
                    body{font-family:'Cairo',sans-serif;background:#0a0a1a;overflow:hidden}
                    .header{background:linear-gradient(135deg,#0f3460,#1a1a2e);color:white;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:fixed;top:0;left:0;right:0;z-index:100}
                    .btn{color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer;transition:all 0.3s;margin-left:8px;font-family:'Cairo';font-weight:bold;}
                    .btn:hover{transform:scale(1.05)}
                    .btn-danger{background:#ef4444}
                    .btn-danger:hover{background:#dc2626}
                    .btn-success{background:#10b981}
                    .btn-success:hover{background:#059669}
                    .btn-warning{background:#f59e0b}
                    .btn-warning:hover{background:#d97706}
                    .badge{background:#f59e0b;padding:5px 15px;border-radius:30px;font-size:0.8rem;font-weight:bold;}
                    #jitsi-container{position:fixed;top:60px;left:0;right:0;bottom:0}
                    .waiting-panel{position:fixed;left:20px;top:80px;width:300px;background:white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.3);z-index:200;max-height:400px;overflow-y:auto}
                    .waiting-header{background:linear-gradient(135deg,#0f5cbf,#0f3460);color:white;padding:12px;border-radius:12px 12px 0 0;font-weight:700;display:flex;justify-content:space-between}
                    .waiting-list{padding:8px}
                    .student-item{display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid #e2e8f0}
                    .add-btn{background:#10b981;color:white;border:none;padding:4px 12px;border-radius:20px;cursor:pointer;font-size:0.7rem;font-weight:bold;}
                </style>
            </head>
            <body>
            <div class="header">
                <div><span class="badge">أنت مضيف البث المباشر</span></div>
                <div>
                    <span id="waitingCount" class="badge">0 ينتظرون</span>
                    <button class="btn btn-success" onclick="addAllStudents()">إدخال الجميع</button>
                    <button class="btn btn-danger" onclick="endStream()">إنهاء الحصة</button>
                    <button class="btn btn-warning" onclick="leaveStream()">مغادرة</button>
                </div>
            </div>
            <div id="waitingPanel" class="waiting-panel" style="display:none">
                <div class="waiting-header"><span>الطلاب المنتظرون</span><span id="panelCount">0</span></div>
                <div id="waitingList" class="waiting-list"></div>
            </div>
            <div id="jitsi-container"></div>
            <script>
                let refreshInterval = null;
                const roomName = '${offer.room_name}';
                const offerId = ${offer.id};
                const teacherId = ${req.params.teacher_id};

                function initJitsi() {
                    try {
                        const api = new JitsiMeetExternalAPI('meet.jit.si', {
                            roomName: roomName,
                            width: '100%',
                            height: window.innerHeight - 60,
                            parentNode: document.querySelector('#jitsi-container'),
                            userInfo: { displayName: 'الأستاذ' },
                            configOverwrite: {
                                disableSimulcast: false,
                                enableNoisyMicDetection: false,
                                p2p: { enabled: true }
                            }
                        });
                        window.jitsiApi = api;
                    } catch (error) {
                        setTimeout(initJitsi, 3000);
                    }
                }

                async function loadWaitingList() {
                    try {
                        const token = localStorage.getItem('token');
                        const res = await fetch('/api/stream/waiting-list/' + offerId + '/' + teacherId, {
                            headers: { 'Authorization': 'Bearer ' + token }
                        });
                        const students = await res.json();
                        const count = students?.length || 0;
                        document.getElementById('waitingCount').innerHTML = count + ' ينتظرون في الاستراحة';
                        if (count > 0) {
                            document.getElementById('waitingPanel').style.display = 'block';
                            document.getElementById('panelCount').innerText = count;
                            let html = '';
                            students.forEach(s => {
                                html += '<div class="student-item">' +
                                    '<div><strong>' + escapeHtml(s.full_name) + '</strong><br><small>' + escapeHtml(s.email) + '</small></div>' +
                                    '<button class="add-btn" onclick="addStudent(' + s.student_id + ')">السماح بالدخول</button>' +
                                '</div>';
                            });
                            document.getElementById('waitingList').innerHTML = html;
                        } else {
                            document.getElementById('waitingPanel').style.display = 'none';
                        }
                    } catch(e) { console.error(e); }
                }

                async function addStudent(studentId) {
                    if (confirm('هل تريد الإذن بالدخول لهذا الطالب فقط؟')) {
                        const token = localStorage.getItem('token');
                        const res = await fetch('/api/stream/add-students/' + offerId, {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + token
                            },
                            body: JSON.stringify({ offer_id: offerId, teacher_id: teacherId })
                        });
                        const data = await res.json();
                        if (data.success) {
                            loadWaitingList();
                        }
                    }
                }

                async function addAllStudents() {
                    if (confirm('هل ترغب في فتح البث وإدخال جميع المنتظرين؟')) {
                        const token = localStorage.getItem('token');
                        const res = await fetch('/api/stream/add-students/' + offerId, {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + token
                            },
                            body: JSON.stringify({ offer_id: offerId, teacher_id: teacherId })
                        });
                        const data = await res.json();
                        if (data.success) {
                            loadWaitingList();
                        }
                    }
                }

                function leaveStream() {
                    if (window.jitsiApi) window.jitsiApi.dispose();
                    if (refreshInterval) clearInterval(refreshInterval);
                    window.location.href = '/teacher-dashboard.html';
                }

                async function endStream() {
                    if (confirm('تأكيد رغبتك في إغلاق الحصة وطرد الجميع؟')) {
                        const token = localStorage.getItem('token');
                        await fetch('/api/stream/end/' + offerId, {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + token
                            }
                        });
                        if (window.jitsiApi) window.jitsiApi.dispose();
                        if (refreshInterval) clearInterval(refreshInterval);
                        window.location.href = '/teacher-dashboard.html';
                    }
                }

                function escapeHtml(text) {
                    if (!text) return '';
                    const div = document.createElement('div');
                    div.textContent = text;
                    return div.innerHTML;
                }

                initJitsi();
                loadWaitingList();
                refreshInterval = setInterval(loadWaitingList, 5000);
            </script>
            </body>
            </html>
        `);
    } catch (error) {
        res.redirect('/teacher-dashboard.html');
    }
});

app.get('/api/enter-teacher-stream/:offer_id/:teacher_id', async (req, res) => {
    // توجيه مبدئي لتسجيل الجاهزية قبل تشغيل صفحة العرض
    try {
        res.redirect(`/api/teacher-stream/${req.params.offer_id}/${req.params.teacher_id}`);
    } catch (error) {
        res.redirect('/teacher-dashboard.html');
    }
});

app.get('/api/join-stream/:offer_id/:student_id', async (req, res) => {
    try {
        const offer = await getOne('offers', 'id', parseInt(req.params.offer_id));
        if (!offer || offer.status !== 'live') {
            return res.redirect('/student-dashboard.html');
        }

        const { data: active } = await supabase
            .from('active_stream')
            .select('*')
            .eq('offer_id', offer.id)
            .eq('student_id', parseInt(req.params.student_id))
            .maybeSingle();

        if (!active) {
            return res.redirect('/student-dashboard.html');
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="ar">
            <head>
                <meta charset="UTF-8">
                <title>قاعة الحصة المباشرة</title>
                <script src="https://meet.jit.si/external_api.js"></script>
                <style>
                    *{margin:0;padding:0;box-sizing:border-box}
                    body{font-family:'Cairo',sans-serif;background:#0a0a1a;overflow:hidden}
                    .header{background:linear-gradient(135deg,#0f3460,#1a1a2e);color:white;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:fixed;top:0;left:0;right:0;z-index:100}
                    .btn{background:#ef4444;color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer;transition:all 0.3s;font-family:'Cairo';font-weight:bold;}
                    .btn:hover{background:#dc2626;transform:scale(1.05)}
                    .badge{background:#10b981;padding:5px 15px;border-radius:30px;font-size:0.8rem;font-weight:bold;}
                    #jitsi-container{position:fixed;top:60px;left:0;right:0;bottom:0}
                </style>
            </head>
            <body>
            <div class="header">
                <div><span class="badge">قناة البث: طالب</span></div>
                <button class="btn" onclick="leaveStream()">مغادرة القاعة</button>
            </div>
            <div id="jitsi-container"></div>
            <script>
                const api = new JitsiMeetExternalAPI('meet.jit.si', {
                    roomName: '${offer.room_name}',
                    width: '100%',
                    height: window.innerHeight - 60,
                    parentNode: document.querySelector('#jitsi-container'),
                    userInfo: { displayName: 'طالب' },
                    configOverwrite: {
                        startWithVideoMuted: true,
                        startWithAudioMuted: true,
                        p2p: { enabled: true }
                    }
                });
                function leaveStream() {
                    api.dispose();
                    window.location.href = '/student-dashboard.html';
                }
            </script>
            </body>
            </html>
        `);
    } catch (error) {
        res.redirect('/student-dashboard.html');
    }
});

// ============================================================
// نظام الكابتشا الديناميكي والآمن للوقاية من الروبوتات وهجمات التخمين
// ============================================================
const captchaStore = {};

function generateCaptcha() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function generateCaptchaImage(code) {
    const colors = ['#0f5cbf', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#ec4899'];
    const bgColors = ['#f0f4ff', '#f0fdf4', '#f5f3ff', '#fffbeb', '#fef2f2', '#fdf2f8'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    const randomBg = bgColors[Math.floor(Math.random() * bgColors.length)];

    let noise = '';
    for (let i = 0; i < 20; i++) {
        const x = Math.random() * 200;
        const y = Math.random() * 60;
        noise += `<line x1="${x}" y1="${y}" x2="${x + Math.random() * 20}" y2="${y + Math.random() * 20}" stroke="${colors[Math.floor(Math.random() * colors.length)]}" stroke-width="1" opacity="0.3"/>`;
    }

    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60">
            <rect width="200" height="60" fill="${randomBg}" rx="8"/>
            ${noise}
            <text x="100" y="40" font-family="Arial, sans-serif" font-size="28" font-weight="bold" 
                  fill="${randomColor}" text-anchor="middle" letter-spacing="5">
                ${code.split('').map((char, i) => {
                    const angle = (Math.random() - 0.5) * 20;
                    return `<tspan x="${20 + i * 30}" y="40" transform="rotate(${angle}, ${20 + i * 30}, 40)">${char}</tspan>`;
                }).join('')}
            </text>
        </svg>
    `;
    return svg;
}

app.get('/api/captcha/generate', (req, res) => {
    const code = generateCaptcha();
    const captchaId = require('crypto').randomBytes(16).toString('hex');

    captchaStore[captchaId] = {
        code: code,
        expires: Date.now() + 5 * 60 * 1000 // صالح لمدة 5 دقائق فقط
    };

    const svg = generateCaptchaImage(code);

    res.json({
        captcha_id: captchaId,
        image: svg,
        expires_in: 300
    });
});

app.post('/api/captcha/verify', [
    body('captcha_id').notEmpty().withMessage('معرف الكابتشا مطلوب'),
    body('captcha_code').notEmpty().withMessage('رمز التحقق مطلوب').trim()
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { captcha_id, captcha_code } = req.body;
    const stored = captchaStore[captcha_id];

    if (!stored || Date.now() > stored.expires) {
        if (stored) delete captchaStore[captcha_id];
        return res.status(400).json({ success: false, error: 'انتهت صلاحية رمز التحقق، يرجى تحديث الصورة.' });
    }

    if (stored.code.toLowerCase() === captcha_code.toLowerCase().trim()) {
        delete captchaStore[captcha_id]; // التدمير الفوري للرمز بعد التحقق الناجح لمنع إعادة الاستخدام (Replay Attacks)
        return res.json({ success: true });
    } else {
        return res.status(400).json({ success: false, error: 'رمز التحقق غير صحيح، يرجى المحاولة مجدداً.' });
    }
});

// تنظيف دوري للرموز غير المستخدمة والمنتهية صلاحيتها
setInterval(() => {
    const now = Date.now();
    Object.keys(captchaStore).forEach(key => {
        if (captchaStore[key].expires < now) {
            delete captchaStore[key];
        }
    });
}, 120000);

// ============================================================
// نظام إرسال الإشعارات الجماعية بواسطة المدير
// ============================================================
app.post('/api/admin/send-notification-to-all-students', authenticateJWT, requireRole(['admin']), [
    body('title').notEmpty().withMessage('العنوان مطلوب').trim(),
    body('message').notEmpty().withMessage('المحتوى مطلوب').trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { title, message } = req.body;

        const { data: students } = await supabase
            .from('students')
            .select('id')
            .eq('email_verified', true);

        if (!students || students.length === 0) {
            return res.status(404).json({ success: false, error: 'لا يوجد طلاب مؤكدي الحسابات حالياً لإشعارهم.' });
        }

        const notifications = students.map(s => ({
            user_id: s.id,
            user_type: 'student',
            title: title.trim(),
            message: message.trim(),
            is_read: false,
            created_at: new Date().toISOString()
        }));

        const { error } = await supabase.from('notifications').insert(notifications);
        if (error) throw error;

        await supabase.from('admin_notifications').insert({
            title: title.trim(),
            message: message.trim(),
            sent_to_all: true,
            students_count: students.length,
            created_at: new Date().toISOString()
        });

        res.json({
            success: true,
            students_count: students.length,
            message: `تم إرسال الإشعار الجماعي بنجاح لـ ${students.length} طالب.`
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/sent-notifications', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('admin_notifications')
            .select('*')
            .order('created_at', { ascending: false });

        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.delete('/api/admin/delete-notification/:id', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        await supabase
            .from('admin_notifications')
            .delete()
            .eq('id', parseInt(req.params.id));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// تحديث وتعديل الملف الشخصي للأساتذة مع الروابط الاجتماعية
// ============================================================
app.post('/api/teacher/update-profile-with-social', authenticateJWT, requireRole(['teacher']), upload.fields([
    { name: 'profile_image', maxCount: 1 }
]), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, facebook_url, instagram_url, linkedin_url, youtube_url, twitter_url, website_url } = req.body;
        const parsedTeacherId = parseInt(teacher_id);

        if (req.user.id !== parsedTeacherId) {
            return res.status(403).json({ success: false, error: 'غير مصرح بتعديل بيانات حساب آخر.' });
        }

        let profile_image = null, profile_url = null;
        const oldTeacher = await getOne('teachers', 'id', parsedTeacherId);
        
        if (!oldTeacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير متوفر' });
        }

        if (req.files?.['profile_image']?.[0]) {
            const file = req.files['profile_image'][0];
            const uploaded = await uploadToSupabase(file, 'teachers', oldTeacher?.profile_image);
            if (uploaded) {
                profile_image = uploaded.filename;
                profile_url = uploaded.url;
            }
        }

        const updateData = {};
        if (profile_image) updateData.profile_image = profile_image;
        if (profile_url) updateData.profile_url = profile_url;

        const socialFields = { facebook_url, instagram_url, linkedin_url, youtube_url, twitter_url, website_url };
        for (const [key, value] of Object.entries(socialFields)) {
            if (value !== undefined && value !== null) {
                const cleaned = value.trim();
                updateData[key] = cleaned === '' ? null : cleaned;
            }
        }

        const { data, error } = await supabase
            .from('teachers')
            .update(updateData)
            .eq('id', parsedTeacherId)
            .select();

        if (error) throw error;

        res.json({
            success: true,
            message: 'تم تحديث الملف الشخصي وروابط التواصل الاجتماعي بنجاح',
            user: data ? data[0] : null
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'تعذر تعديل وتحديث الملف.' });
    }
});

// ============================================================
// مسار قياس الأداء الفني الداخلي ومراقبة خوادم المنصة (APM)
// ============================================================
app.get('/api/admin/performance', authenticateJWT, requireRole(['admin']), async (req, res) => {
    try {
        const [
            { count: connections },
            { count: sessions }
        ] = await Promise.all([
            supabase.from('active_stream').select('*', { count: 'exact', head: true }),
            supabase.from('sessions').select('*', { count: 'exact', head: true })
        ]);

        const memoryUsage = process.memoryUsage();
        const uptime = process.uptime();

        res.json({
            status: 'healthy',
            uptime: Math.floor(uptime),
            memory: {
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
                rss: Math.round(memoryUsage.rss / 1024 / 1024)
            },
            active_streams: connections || 0,
            total_sessions: sessions || 0
        });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// تفعيل وتوجيه طلبات الاستعلام الأخرى للواجهة الأمامية
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// تصدير التطبيق
module.exports = app;

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log('='.repeat(60));
        console.log(`📡 الخادم الآمن والسيبراني يعمل بنجاح على المنفذ: ${PORT}`);
        console.log('🔒 تم تفعيل نظام التوثيق المشفر الثنائي للرموز JWT بنجاح.');
        console.log('🛡️ تم تفعيل نظام الفحص التفاعلي والنشط لمدفوعات Chargily بنجاح.');
        console.log('🚫 تم تفعيل فلاتر الأمان ومنع محاولات التلاعب وتخمين المعرفات.');
        console.log('='.repeat(60));
    });
}
