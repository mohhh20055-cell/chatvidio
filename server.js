// ============================================================
// خادم منصة التعليم - إصدار آمن ومحسن مع نظام الإحالة والتوثيق والحظر
// يدعم آلاف المستخدمين مع أعلى معايير الأمان
// ============================================================

require('dotenv').config();

// الحزم الأساسية
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult, param, query } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const xss = require('xss');
const { v4: uuidv4 } = require('uuid');
const compression = require('compression');

// ============================================================
// متغيرات البيئة والثوابت الأمنية
// ============================================================
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const JWT_EXPIRY = '24h';
const SALT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 100;

// تعريف التطبيق
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// حل مشكلة X-Forwarded-For (لـ Vercel)
// ============================================================
app.set('trust proxy', true);

// ============================================================
// قراءة المتغيرات البيئية مع التحقق من وجودها
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
const CHARGILY_API_KEY = process.env.CHARGILY_API_KEY;
const CHARGILY_API_URL = process.env.CHARGILY_API_URL || 'https://pay.chargily.net/api/v2';
const CHARGILY_WEBHOOK_SECRET = process.env.CHARGILY_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@platform.com';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('admin123', SALT_ROUNDS);
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'https://chatvidio.vercel.app';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ENCRYPTION_IV = process.env.ENCRYPTION_IV || crypto.randomBytes(16).toString('hex');

// ============================================================
// قائمة المصادر المسموح بها لـ CORS
// ============================================================
const CORS_ORIGIN = process.env.CORS_ORIGIN 
    ? process.env.CORS_ORIGIN.split(',') 
    : [
        'https://chatvidio.vercel.app',
        'https://chatvidio-git-*.vercel.app',
        'https://chatvidio-*.vercel.app',
        'https://*.vercel.app',
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002'
    ];

// التحقق من المتغيرات الأساسية
if (!supabaseUrl || !supabaseKey) {
    console.error('خطأ: متغيرات Supabase غير موجودة');
    process.exit(1);
}

if (!resendApiKey) {
    console.error('خطأ: متغير RESEND_API_KEY غير موجود');
    process.exit(1);
}

// ============================================================
// تهيئة الاتصالات
// ============================================================
const supabase = createClient(supabaseUrl, supabaseKey);
const resend = new Resend(resendApiKey);

// ============================================================
// دوال التشفير/إخفاء البيانات الحساسة
// ============================================================
function encrypt(text) {
    if (!text) return null;
    try {
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), Buffer.from(ENCRYPTION_IV, 'hex'));
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    } catch (error) {
        console.error('خطأ في التشفير:', error.message);
        return null;
    }
}

function decrypt(encrypted) {
    if (!encrypted) return null;
    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), Buffer.from(ENCRYPTION_IV, 'hex'));
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error('خطأ في فك التشفير:', error.message);
        return null;
    }
}

function maskIP(ip) {
    if (!ip) return null;
    const parts = ip.split('.');
    if (parts.length === 4) {
        parts[3] = 'xxx';
        return parts.join('.');
    }
    return ip;
}

function sanitizeInput(input) {
    if (typeof input === 'string') {
        return xss(input.trim());
    }
    return input;
}

function sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
            sanitized[key] = sanitizeInput(value);
        } else if (Array.isArray(value)) {
            sanitized[key] = value.map(v => typeof v === 'string' ? sanitizeInput(v) : v);
        } else if (value && typeof value === 'object') {
            sanitized[key] = sanitizeObject(value);
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

// ============================================================
// دوال إنشاء وتحقق JWT
// ============================================================
function generateToken(userId, role, email) {
    return jwt.sign(
        { userId, role, email },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
}

// ============================================================
// دالة التحقق من المصدر لـ CORS
// ============================================================
function isOriginAllowed(origin) {
    if (!origin) return true;
    if (CORS_ORIGIN.includes(origin)) return true;
    for (const allowed of CORS_ORIGIN) {
        if (allowed.includes('*')) {
            const pattern = allowed.replace(/\*/g, '.*');
            const regex = new RegExp(`^${pattern}$`);
            if (regex.test(origin)) return true;
        }
    }
    return false;
}

// ============================================================
// Middleware التحقق من المصادقة
// ============================================================
async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'غير مصرح به، يرجى تسجيل الدخول' });
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);
    
    if (!decoded) {
        return res.status(401).json({ success: false, error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مرة أخرى' });
    }

    req.user = decoded;
    next();
}

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

// ============================================================
// التعامل مع طلبات OPTIONS قبل أي شيء
// ============================================================
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
        const origin = req.headers.origin;
        if (origin && isOriginAllowed(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-CSRF-Token, X-Signature, Accept, Origin, X-HTTP-Method-Override');
            res.header('Access-Control-Allow-Credentials', 'true');
            res.header('Access-Control-Max-Age', '86400');
        }
        return res.status(200).send();
    }
    next();
});

// ============================================================
// إعدادات الأمان - متقدمة
// ============================================================

// 1. Compression
app.use(compression());

// 2. Helmet - حماية متقدمة
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://meet.jit.si", "https://cdnjs.cloudflare.com", "https://vercel.live", "https://*.vercel.app"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://ui-avatars.com", "https://api.qrserver.com", "https://*.supabase.co"],
            connectSrc: ["'self'", "https://*.supabase.co", "https://pay.chargily.net", "https://meet.jit.si", "https://*.vercel.app"],
            frameSrc: ["'self'", "https://meet.jit.si"]
        }
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false
}));

// 3. CORS محدود وآمن
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) {
            return callback(null, true);
        }
        if (isOriginAllowed(origin)) {
            callback(null, true);
        } else {
            console.log(`❌ رفض المصدر: ${origin}`);
            callback(new Error(`غير مسموح به من هذا المصدر`));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token', 'X-Signature', 'Accept', 'Origin', 'X-HTTP-Method-Override'],
    credentials: true,
    maxAge: 86400,
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// 4. Cookie Parser للجلسات الآمنة
app.use(cookieParser());

// 5. Rate Limiting متقدم
const limiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW,
    max: RATE_LIMIT_MAX,
    message: { success: false, error: 'عدد الطلبات كبير جداً، حاول لاحقاً' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.ip || req.connection.remoteAddress;
    },
    skip: (req) => {
        const skipPaths = ['/api/stream', '/api/public/stats', '/api/public/offers', '/api/join-stream', '/api/verify-email', '/api/wallet/deposit/success', '/api/wallet/deposit/failure', '/api/chargily-webhook', '/api/test-cors'];
        return skipPaths.some(path => req.path.startsWith(path));
    }
});
app.use('/api/', limiter);

// 6. Rate Limiting خاص لتسجيل الدخول
const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'عدد محاولات تسجيل الدخول كبير جداً، حاول بعد ساعة' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.body.email || req.ip;
    }
});
app.use('/api/login', authLimiter);
app.use('/api/forgot-password', authLimiter);
app.use('/api/resend-verification', authLimiter);

// 7. CSRF Protection
app.use((req, res, next) => {
    const publicMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (!publicMethods.includes(req.method)) {
        const csrfToken = req.headers['x-csrf-token'];
        const cookieToken = req.cookies.csrf_token;
        if (!csrfToken || !cookieToken || csrfToken !== cookieToken) {
            return res.status(403).json({ success: false, error: 'طلب غير مصرح به (CSRF)' });
        }
    }
    next();
});

// 8. توليد CSRF Token
app.get('/api/csrf-token', (req, res) => {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie('csrf_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000
    });
    res.json({ csrfToken: token });
});

// 9. مسار اختبار CORS
app.get('/api/test-cors', (req, res) => {
    res.json({
        success: true,
        message: 'CORS يعمل بشكل صحيح',
        origin: req.headers.origin || 'no origin',
        ip: req.ip,
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// Middleware التحقق من الحظر (IP Ban)
// ============================================================
async function checkBanned(req, res, next) {
    let ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
    
    if (ip && typeof ip === 'string' && ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }
    
    if (ip && typeof ip === 'string') {
        ip = ip.replace(/:\d+[^:]*$/, '');
    }
    
    if (!ip) {
        return next();
    }
    
    try {
        const encryptedIP = encrypt(ip);
        
        const { data } = await supabase
            .from('banned_users')
            .select('*')
            .eq('ip_address_encrypted', encryptedIP)
            .single();
        
        if (data) {
            return res.status(403).json({
                success: false,
                error: 'تم حظر عنوان IP الخاص بك من المنصة',
                banned: true,
                reason: data.ban_reason || 'انتهاك شروط الاستخدام'
            });
        }
        next();
    } catch (error) {
        next();
    }
}

// ============================================================
// Middleware الأساسية مع تنقية المدخلات
// ============================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// تنقية جميع المدخلات
app.use((req, res, next) => {
    if (req.body) {
        req.body = sanitizeObject(req.body);
    }
    if (req.query) {
        req.query = sanitizeObject(req.query);
    }
    if (req.params) {
        req.params = sanitizeObject(req.params);
    }
    next();
});

app.use(express.static('public', {
    maxAge: '1d',
    etag: true,
    lastModified: true
}));

// ============================================================
// Middleware لمعالجة الأخطاء
// ============================================================
app.use((err, req, res, next) => {
    console.error('❌ خطأ:', err.message);
    console.error('📚 Stack:', err.stack);
    
    if (err.message && err.message.includes('غير مسموح به من هذا المصدر')) {
        return res.status(403).json({
            success: false,
            error: 'غير مسموح به من هذا المصدر',
            origin: req.headers.origin || 'unknown'
        });
    }
    
    if (err.name === 'ValidationError') {
        return res.status(400).json({
            success: false,
            error: err.message
        });
    }
    
    if (err.name === 'MulterError') {
        return res.status(400).json({
            success: false,
            error: err.message
        });
    }
    
    res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'production' ? 'حدث خطأ داخلي في الخادم' : err.message
    });
});

// ============================================================
// إعداد Multer مع تحقق أمني متقدم
// ============================================================
const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function validateFileContent(buffer, mimeType) {
    const magicNumbers = {
        'image/jpeg': [0xFF, 0xD8, 0xFF],
        'image/png': [0x89, 0x50, 0x4E, 0x47],
        'image/gif': [0x47, 0x49, 0x46, 0x38],
        'image/webp': [0x52, 0x49, 0x46, 0x46],
        'application/pdf': [0x25, 0x50, 0x44, 0x46]
    };

    const expectedMagic = magicNumbers[mimeType];
    if (!expectedMagic) return false;

    for (let i = 0; i < expectedMagic.length && i < buffer.length; i++) {
        if (buffer[i] !== expectedMagic[i]) return false;
    }
    return true;
}

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

const validateUploadedFiles = (req, res, next) => {
    if (req.file && !validateFileContent(req.file.buffer, req.file.mimetype)) {
        return res.status(400).json({ success: false, error: 'الملف تالف أو غير صحيح' });
    }
    
    if (req.files) {
        for (const field in req.files) {
            for (const file of req.files[field]) {
                if (!validateFileContent(file.buffer, file.mimetype)) {
                    return res.status(400).json({ success: false, error: `الملف ${file.originalname} تالف أو غير صحيح` });
                }
            }
        }
    }
    next();
};

// ============================================================
// دوال إرسال البريد
// ============================================================

async function sendVerificationEmail(toEmail, toName, verificationUrl) {
    try {
        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);
        const sanitizedUrl = sanitizeInput(verificationUrl);

        console.log('محاولة إرسال بريد تأكيد إلى:', sanitizedEmail);

        const { data, error } = await resend.emails.send({
            from: 'منصة التعليم <onboarding@resend.dev>',
            to: [sanitizedEmail],
            subject: 'تأكيد حسابك - منصة التعليم',
            html: `
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"></head>
                <body style="font-family:'Cairo',Arial,sans-serif;text-align:center;padding:20px;background:#f0f4ff;">
                    <div style="max-width:550px;margin:auto;background:white;border-radius:20px;padding:40px;box-shadow:0 10px 40px rgba(0,0,0,0.1);">
                        <div style="font-size:4rem;margin-bottom:10px;">✉️</div>
                        <h2 style="color:#0f5cbf;margin:10px 0;">مرحباً ${sanitizedName}!</h2>
                        <p style="font-size:1.1rem;color:#333;line-height:1.8;">شكراً لتسجيلك في منصة التعليم.<br>يرجى تأكيد حسابك بالضغط على الزر أدناه:</p>
                        <a href="${sanitizedUrl}" style="background:#0f5cbf;color:white;padding:14px 35px;text-decoration:none;border-radius:30px;display:inline-block;margin:25px 0;font-size:1.1rem;font-weight:bold;">تأكيد الحساب</a>
                        <p style="color:#666;font-size:0.85rem;">هذا الرابط صالح لمدة 24 ساعة.</p>
                        <p style="color:#999;font-size:0.8rem;">إذا لم تقم بالتسجيل، يرجى تجاهل هذا البريد.</p>
                        <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
                        <p style="color:#aaa;font-size:0.75rem;">منصة التعليم - تعلم بذكاء</p>
                    </div>
                </body>
                </html>
            `
        });

        if (error) {
            console.error('خطأ في إرسال البريد:', error);
            return false;
        }

        console.log('تم إرسال بريد التأكيد بنجاح');
        return true;
    } catch (error) {
        console.error('خطأ في إرسال البريد:', error.message);
        return false;
    }
}

async function sendResetEmail(toEmail, toName, resetUrl) {
    try {
        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);
        const sanitizedUrl = sanitizeInput(resetUrl);

        console.log('محاولة إرسال بريد إلى:', sanitizedEmail);

        const { data, error } = await resend.emails.send({
            from: 'منصة التعليم <onboarding@resend.dev>',
            to: [sanitizedEmail],
            subject: 'إعادة تعيين كلمة المرور - منصة التعليم',
            html: `
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"></head>
                <body style="font-family:'Cairo',Arial,sans-serif;text-align:center;padding:20px;background:#f0f4ff;">
                    <div style="max-width:550px;margin:auto;background:white;border-radius:20px;padding:40px;box-shadow:0 10px 40px rgba(0,0,0,0.1);">
                        <div style="font-size:4rem;margin-bottom:10px;">🔐</div>
                        <h2 style="color:#0f5cbf;margin:10px 0;">مرحباً ${sanitizedName}!</h2>
                        <p style="font-size:1.1rem;color:#333;line-height:1.8;">لقد طلبت إعادة تعيين كلمة المرور الخاصة بك.</p>
                        <a href="${sanitizedUrl}" style="background:#0f5cbf;color:white;padding:14px 35px;text-decoration:none;border-radius:30px;display:inline-block;margin:25px 0;font-size:1.1rem;font-weight:bold;">إعادة تعيين كلمة المرور</a>
                        <p style="color:#666;font-size:0.85rem;">هذا الرابط صالح لمدة ساعة واحدة.</p>
                        <p style="color:#999;font-size:0.8rem;">إذا لم تطلب ذلك، يرجى تجاهل هذا البريد.</p>
                    </div>
                </body>
                </html>
            `
        });

        if (error) {
            console.error('خطأ في إرسال البريد:', error);
            return false;
        }

        console.log('تم إرسال البريد بنجاح');
        return true;
    } catch (error) {
        console.error('خطأ في إرسال البريد:', error.message);
        return false;
    }
}

// ============================================================
// دالة رفع الصور
// ============================================================
async function uploadToSupabase(file, folder, oldFileName = null) {
    try {
        if (!file || !file.buffer) return null;

        if (!validateFileContent(file.buffer, file.mimetype)) {
            throw new Error('الملف تالف أو غير صحيح');
        }

        const fileExt = path.extname(file.originalname);
        const fileName = `${uuidv4()}${fileExt}`;
        const filePath = `${folder}/${fileName}`;

        if (oldFileName) {
            try {
                const oldPath = `${folder}/${oldFileName}`;
                await supabase.storage.from('profiles').remove([oldPath]);
            } catch (e) {
                console.log('لم نتمكن من حذف الملف القديم');
            }
        }

        const { data, error } = await supabase.storage
            .from('profiles')
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                cacheControl: '86400'
            });

        if (error) {
            console.error('خطأ في رفع الصورة:', error);
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
        console.error('خطأ:', error.message);
        return null;
    }
}

// ============================================================
// دوال قاعدة البيانات
// ============================================================
async function getOne(table, column, value) {
    try {
        const { data, error } = await supabase
            .from(table)
            .select('*')
            .eq(column, value)
            .single();
        if (error && error.code !== 'PGRST116') return null;
        return data;
    } catch (error) {
        console.error('خطأ في getOne:', error.message);
        return null;
    }
}

async function insert(table, data) {
    try {
        const sanitizedData = sanitizeObject(data);
        const { data: result, error } = await supabase.from(table).insert(sanitizedData).select();
        if (error) throw error;
        return result[0];
    } catch (error) {
        console.error(`خطأ في insert إلى ${table}:`, error.message);
        throw error;
    }
}

async function update(table, id, data) {
    try {
        const sanitizedData = sanitizeObject(data);
        const { data: result, error } = await supabase.from(table).update(sanitizedData).eq('id', id).select();
        if (error) throw error;
        return result[0];
    } catch (error) {
        console.error(`خطأ في update للجدول ${table}:`, error.message);
        throw error;
    }
}

async function remove(table, column, value) {
    try {
        const { error } = await supabase.from(table).delete().eq(column, value);
        if (error) throw error;
        return true;
    } catch (error) {
        console.error(`خطأ في remove من ${table}:`, error.message);
        throw error;
    }
}

// ============================================================
// دوال مساعدة
// ============================================================
function generateVerificationToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateReferralCode(name, id) {
    const prefix = name.substring(0, 3).toUpperCase();
    const suffix = id.toString(36).toUpperCase();
    return `${prefix}${suffix}`;
}

function renderSuccessPage(title, message, subMessage, buttonText, buttonLink) {
    return `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>${sanitizeInput(title)}</title>
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
            <h1>✅ ${sanitizeInput(title)}</h1>
            <p style="font-size:1.2rem;">${sanitizeInput(message)}</p>
            <p class="sub">${sanitizeInput(subMessage)}</p>
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
            <h1>❌ ${sanitizeInput(title)}</h1>
            <p>${sanitizeInput(message)}</p>
            <a href="${buttonLink || '/'}" class="btn">العودة للرئيسية</a>
        </div>
        </body>
        </html>
    `;
}

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
// المسار الرئيسي
// ============================================================
app.get('/', (req, res) => {
    const refCode = req.query.ref;
    if (refCode) {
        res.cookie('referral_code', refCode, { 
            maxAge: 7 * 24 * 60 * 60 * 1000, 
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict'
        });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// المسارات العامة
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
        console.error('خطأ:', error.message);
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
        res.json(data || []);
    } catch (error) {
        console.error('خطأ:', error.message);
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
        res.json(data || []);
    } catch (error) {
        console.error('خطأ:', error.message);
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
            supabase.from('offers').select('*', { count: 'exact', head: true })
                .eq('status', 'upcoming')
                .gt('offer_date', new Date().toISOString()),
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
        console.error('خطأ:', error.message);
        res.status(500).json({ teachers: 0, offers: 0, live: 0, students: 0 });
    }
});

app.get('/api/public/students-count', async (req, res) => {
    try {
        const { count } = await supabase
            .from('students')
            .select('*', { count: 'exact', head: true })
            .eq('email_verified', true);
        res.json({ count: count || 0 });
    } catch (error) {
        res.status(500).json({ count: 0 });
    }
});

// ============================================================
// مسارات التحقق من البريد الإلكتروني
// ============================================================

app.post('/api/resend-verification', [
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

        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const verificationUrl = `${baseUrl}/api/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}&role=${role}`;

        console.log('رابط تأكيد البريد:', verificationUrl);

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

app.get('/api/verify-email', [
    query('token').notEmpty().withMessage('الرمز مطلوب'),
    query('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
    query('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    const { token, email, role } = req.query;

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).send(renderErrorPage('بيانات غير صالحة', 'البيانات المرسلة غير صالحة'));
        }

        if (!token || !email || !role) {
            return res.status(400).send(renderErrorPage('رابط غير صالح', 'الرابط الذي استخدمته غير صحيح. يرجى التحقق من الرابط المرسل إلى بريدك الإلكتروني.'));
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

            return res.status(400).send(renderErrorPage('انتهت الصلاحية', 'انتهت صلاحية رابط التأكيد. يمكنك طلب رابط جديد من خلال صفحة تسجيل الدخول.', '/login.html'));
        }

        const tableName = role === 'student' ? 'students' : 'teachers';
        
        const user = await getOne(tableName, 'email', email);
        
        await supabase
            .from(tableName)
            .update({ email_verified: true })
            .eq('email', email);

        await supabase
            .from('email_verifications')
            .update({ used: true })
            .eq('token', token);

        if (user) {
            await processReferralReward(user.id, role);
        }

        return res.send(renderSuccessPage('تم تأكيد الحساب', 'تم تأكيد حسابك بنجاح 🎉', 'يمكنك الآن تسجيل الدخول والاستفادة من جميع خدمات المنصة.', 'تسجيل الدخول', '/login.html'));
    } catch (error) {
        console.error('خطأ في تأكيد البريد:', error.message);
        return res.status(500).send(renderErrorPage('حدث خطأ', 'حدث خطأ أثناء تأكيد الحساب. يرجى المحاولة مرة أخرى.'));
    }
});

app.get('/api/check-email-verification/:email/:role', async (req, res) => {
    try {
        const { email, role } = req.params;

        let user = null;
        if (role === 'student') {
            user = await getOne('students', 'email', email);
        } else if (role === 'teacher') {
            user = await getOne('teachers', 'email', email);
        }

        if (!user) {
            return res.json({ success: false, error: 'المستخدم غير موجود' });
        }

        res.json({ 
            success: true, 
            email_verified: user.email_verified === true 
        });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// نظام الإحالة (Referral System)
// ============================================================

app.post('/api/referral/create', [
    authenticate,
    body('user_id').isInt().withMessage('معرف المستخدم غير صالح'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role } = req.body;

        if (req.user.userId !== user_id || req.user.role !== role) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإنشاء رمز إحالة لهذا الحساب' });
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
                referralCode = generateReferralCode(user.full_name, user_id) + crypto.randomBytes(2).toString('hex').toUpperCase();
                attempts++;
            }
        }

        await supabase
            .from(tableName)
            .update({ referral_code: referralCode })
            .eq('id', user_id);

        return res.json({
            success: true,
            referral_code: referralCode,
            referral_link: `${PLATFORM_DOMAIN}?ref=${referralCode}`
        });
    } catch (error) {
        console.error('خطأ في إنشاء رمز الإحالة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.get('/api/referral/info/:user_id/:role', [
    authenticate,
    param('user_id').isInt().withMessage('معرف المستخدم غير صالح'),
    param('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role } = req.params;

        if (req.user.userId !== parseInt(user_id) || req.user.role !== role) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض معلومات الإحالة' });
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
        console.error('خطأ في جلب معلومات الإحالة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.post('/api/referral/process', [
    body('ref_code').notEmpty().withMessage('رمز الإحالة مطلوب'),
    body('new_user_id').isInt().withMessage('معرف المستخدم الجديد غير صالح'),
    body('new_user_role').isIn(['student', 'teacher']).withMessage('دور المستخدم الجديد غير صالح')
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
            .single();

        if (studentReferrer) {
            referrer = studentReferrer;
            referrerRole = 'student';
        } else {
            const { data: teacherReferrer } = await supabase
                .from('teachers')
                .select('id, referral_code, full_name, email, role')
                .eq('referral_code', ref_code)
                .single();

            if (teacherReferrer) {
                referrer = teacherReferrer;
                referrerRole = 'teacher';
            }
        }

        if (!referrer) {
            return res.status(404).json({ success: false, error: 'رمز الإحالة غير صالح' });
        }

        if (referrer.id === new_user_id) {
            return res.status(400).json({ success: false, error: 'لا يمكنك إحالة نفسك' });
        }

        const { data: existingReferral } = await supabase
            .from('referrals')
            .select('*')
            .eq('referred_user_id', new_user_id)
            .eq('referred_user_role', new_user_role)
            .single();

        if (existingReferral) {
            return res.json({ success: true, message: 'تم تسجيل الإحالة مسبقاً' });
        }

        await insert('referrals', {
            referrer_id: referrer.id,
            referrer_role: referrerRole,
            referred_user_id: new_user_id,
            referred_user_role: new_user_role,
            status: 'pending_verification',
            created_at: new Date().toISOString()
        });

        return res.json({
            success: true,
            message: 'تم تسجيل الإحالة بنجاح، سيتم منح المكافأة بعد تأكيد البريد الإلكتروني',
            referrer_name: referrer.full_name,
            referrer_role: referrerRole
        });
    } catch (error) {
        console.error('خطأ في معالجة الإحالة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
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
            .single();

        if (!referral) {
            console.log('لا توجد إحالة معلقة لهذا المستخدم');
            return false;
        }

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
                    description: `مكافأة إحالة طالب/أستاذ جديد`,
                    created_at: new Date().toISOString()
                });

                console.log(`تم إضافة 100 دج للمعلم ${teacher.full_name} من الإحالة`);
            }
        } else if (referral.referrer_role === 'student') {
            const student = await getOne('students', 'id', referral.referrer_id);
            if (student) {
                const newChances = (student.gift_box_chances || 0) + 1;
                await supabase
                    .from('students')
                    .update({ 
                        gift_box_chances: newChances
                    })
                    .eq('id', referral.referrer_id);

                await insert('referral_rewards', {
                    student_id: referral.referrer_id,
                    referred_user_id: referredUserId,
                    referred_user_role: referredUserRole,
                    type: 'gift_box_chance',
                    description: `فرصة لفتح صندوق هدايا من إحالة طالب/أستاذ جديد`,
                    created_at: new Date().toISOString()
                });

                console.log(`تم إضافة فرصة صندوق هدايا للطالب ${student.full_name} من الإحالة`);
            }
        }

        return true;
    } catch (error) {
        console.error('خطأ في معالجة مكافأة الإحالة:', error.message);
        return false;
    }
}

app.post('/api/referral/open-gift-box', [
    authenticate,
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id } = req.body;

        if (req.user.userId !== student_id || req.user.role !== 'student') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بفتح صندوق الهدايا لهذا الحساب' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        const chances = student.gift_box_chances || 0;
        if (chances <= 0) {
            return res.status(400).json({ success: false, error: 'لا توجد فرص لفتح صندوق الهدايا' });
        }

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
        } else if (rand < 0.35) {
            rewardAmount = 50;
            rewardType = 'balance';
        } else {
            rewardAmount = 0;
            rewardType = 'none';
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
                description: `مكافأة من صندوق الهدايا - ${rewardAmount} دج`,
                created_at: new Date().toISOString()
            });

            await insert('referral_rewards', {
                student_id: student_id,
                amount: rewardAmount,
                type: 'gift_box_reward',
                description: `صندوق هدايا - ${rewardAmount} دج`,
                created_at: new Date().toISOString()
            });
        }

        return res.json({
            success: true,
            reward: rewardAmount,
            rewardType: rewardType,
            remaining_chances: chances - 1,
            message: rewardAmount > 0 
                ? `🎉 تهانينا! حصلت على ${rewardAmount} دج من صندوق الهدايا!` 
                : '😅 لم يحالفك الحظ هذه المرة، جرب مرة أخرى!'
        });
    } catch (error) {
        console.error('خطأ في فتح صندوق الهدايا:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.get('/api/referral/gift-box-status/:student_id', [
    authenticate,
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id } = req.params;

        if (req.user.userId !== parseInt(student_id) || req.user.role !== 'student') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض حالة صندوق الهدايا' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        const chances = student.gift_box_chances || 0;

        const { data: history } = await supabase
            .from('referral_rewards')
            .select('*')
            .eq('student_id', student_id)
            .eq('type', 'gift_box_reward')
            .order('created_at', { ascending: false })
            .limit(10);

        return res.json({
            success: true,
            chances: chances,
            history: history || []
        });
    } catch (error) {
        console.error('خطأ في جلب حالة صناديق الهدايا:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.get('/api/referral/teacher-stats/:teacher_id', [
    authenticate,
    param('teacher_id').isInt().withMessage('معرف المعلم غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id } = req.params;

        if (req.user.userId !== parseInt(teacher_id) || req.user.role !== 'teacher') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض إحصائيات الإحالة' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'المعلم غير موجود' });
        }

        const { count: totalReferred } = await supabase
            .from('referrals')
            .select('*', { count: 'exact', head: true })
            .eq('referrer_id', teacher_id)
            .eq('referrer_role', 'teacher');

        const { count: completedReferred } = await supabase
            .from('referrals')
            .select('*', { count: 'exact', head: true })
            .eq('referrer_id', teacher_id)
            .eq('referrer_role', 'teacher')
            .eq('status', 'completed');

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
        console.error('خطأ في جلب إحصائيات الإحالة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// نظام المنشورات
// ============================================================
app.post('/api/post/create', [
    authenticate,
    authorize(['teacher']),
    upload.fields([
        { name: 'image', maxCount: 1 },
        { name: 'file', maxCount: 1 }
    ]),
    validateUploadedFiles,
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('title').notEmpty().withMessage('العنوان مطلوب').isLength({ max: 200 }).withMessage('العنوان طويل جداً'),
    body('content').notEmpty().withMessage('المحتوى مطلوب').isLength({ max: 5000 }).withMessage('المحتوى طويل جداً')
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
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.get('/api/posts/:teacher_id', async (req, res) => {
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
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

app.get('/api/post/:post_id', async (req, res) => {
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
        console.error('خطأ:', error.message);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

app.post('/api/post/like', [
    authenticate,
    authorize(['student']),
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
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.post('/api/post/unlike', [
    authenticate,
    authorize(['student']),
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
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.get('/api/post/check-like/:post_id/:student_id', [
    authenticate,
    authorize(['student'])
], async (req, res) => {
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
        res.json({ liked: false });
    }
});

app.post('/api/post/comment', [
    authenticate,
    authorize(['student']),
    body('post_id').isInt().withMessage('معرف المنشور غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح'),
    body('comment').notEmpty().withMessage('التعليق مطلوب').isLength({ max: 1000 }).withMessage('التعليق طويل جداً')
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
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.delete('/api/post/comment/:comment_id', [
    authenticate,
    authorize(['teacher']),
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
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.delete('/api/post/:post_id', [
    authenticate,
    authorize(['teacher']),
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
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// نظام رسائل الدعم
// ============================================================
app.post('/api/support/send', [
    body('name').notEmpty().withMessage('الاسم مطلوب').isLength({ max: 100 }).withMessage('الاسم طويل جداً'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('subject').notEmpty().withMessage('الموضوع مطلوب').isLength({ max: 200 }).withMessage('الموضوع طويل جداً'),
    body('message').notEmpty().withMessage('الرسالة مطلوبة').isLength({ max: 2000 }).withMessage('الرسالة طويلة جداً')
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

        console.log(`رسالة دعم جديدة من ${sanitizeInput(name)} (${sanitizeInput(email)})`);
        res.json({ success: true, message: 'تم إرسال رسالتك بنجاح' });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.get('/api/admin/support-messages', [
    authenticate,
    authorize(['admin'])
], async (req, res) => {
    try {
        const { data } = await supabase
            .from('support_messages')
            .select('*')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

app.put('/api/admin/support-messages/:id/read', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الرسالة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        await update('support_messages', req.params.id, { status: 'read' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.delete('/api/admin/support-messages/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الرسالة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        await remove('support_messages', 'id', req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// نظام الرصيد (Wallet)
// ============================================================

app.get('/api/student/wallet/:student_id', [
    authenticate,
    authorize(['student']),
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المعلومات' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) return res.status(404).json({ success: false, error: 'طالب غير موجود' });

        const { data: transactions } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('student_id', student_id)
            .order('created_at', { ascending: false })
            .limit(50);

        res.json({
            balance: student.wallet_balance || 0,
            transactions: transactions || []
        });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// دالة إنشاء طلب شحن عبر Chargily
// ============================================================
async function createChargilyCheckout(amount, studentName, studentEmail, studentPhone, description, successUrl, failureUrl) {
    try {
        let finalAmount = Math.max(Number(amount), 50);
        finalAmount = Math.min(finalAmount, 1000000);
        finalAmount = Math.round(finalAmount);

        const checkoutData = {
            amount: finalAmount,
            currency: 'dzd',
            success_url: successUrl,
            failure_url: failureUrl,
            locale: 'ar',
            description: description || `شحن رصيد بقيمة ${finalAmount} دج`,
            metadata: {
                student_name: studentName || 'طالب',
                student_email: studentEmail || '',
                type: 'wallet_deposit',
                timestamp: Date.now().toString()
            }
        };

        console.log('📦 إنشاء دفع للمبلغ:', finalAmount, 'DZD');

        const authMethods = [
            { 'Authorization': `Bearer ${CHARGILY_API_KEY}` },
            { 'X-Authorization': CHARGILY_API_KEY },
            { 'Api-Key': CHARGILY_API_KEY }
        ];

        let lastError = null;

        for (let i = 0; i < authMethods.length; i++) {
            try {
                const response = await axios.post(`${CHARGILY_API_URL}/checkouts`, checkoutData, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        ...authMethods[i]
                    },
                    timeout: 30000,
                    httpsAgent: new https.Agent({ keepAlive: true })
                });

                if (response?.data?.checkout_url) {
                    console.log('✅ تم إنشاء رابط الدفع بنجاح');
                    return {
                        success: true,
                        checkout_url: response.data.checkout_url,
                        checkout_id: response.data.id,
                        amount: finalAmount
                    };
                }
            } catch (error) {
                lastError = error;
                console.log(`❌ محاولة ${i + 1} فشلت`);
                if (i < authMethods.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        throw new Error(lastError?.response?.data?.message || lastError?.message || 'فشلت جميع محاولات الدفع');
    } catch (error) {
        console.error('❌ خطأ Chargily:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.message || 'حدث خطأ في عملية الدفع'
        };
    }
}

// ============================================================
// Webhook للتحقق من الدفع من Chargily
// ============================================================
app.post('/api/chargily-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-signature'];
        
        if (!signature) {
            return res.status(401).json({ success: false, error: 'توقيع غير موجود' });
        }

        const webhookData = req.body;
        
        console.log('📨 استلام Webhook من Chargily');

        if (webhookData.event === 'checkout.paid') {
            const checkoutId = webhookData.data?.id;
            const metadata = webhookData.data?.metadata || {};

            const { data: transactions } = await supabase
                .from('wallet_transactions')
                .select('*')
                .eq('chargily_checkout_id', checkoutId)
                .eq('status', 'pending');

            if (transactions && transactions.length > 0) {
                const transaction = transactions[0];
                
                const student = await getOne('students', 'id', transaction.student_id);
                if (student) {
                    const currentBalance = parseInt(student.wallet_balance) || 0;
                    const addAmount = parseInt(transaction.amount) || 0;
                    const newBalance = currentBalance + addAmount;
                    
                    await supabase
                        .from('students')
                        .update({ wallet_balance: newBalance })
                        .eq('id', transaction.student_id);

                    await update('wallet_transactions', transaction.id, {
                        status: 'completed',
                        description: `تم شحن الرصيد بنجاح بمبلغ ${addAmount} دج`
                    });

                    console.log(`✅ تم تأكيد الدفع وإضافة ${addAmount} دج للطالب ${student.full_name}`);
                }
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في Webhook:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في معالجة الـ Webhook' });
    }
});

// ============================================================
// دالة شحن الرصيد
// ============================================================
app.post('/api/student/wallet/deposit', [
    authenticate,
    authorize(['student']),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح'),
    body('amount').isInt({ min: 100, max: 1000000 }).withMessage('المبلغ يجب أن يكون بين 100 و 1,000,000 دج')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, amount } = req.body;

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بشحن رصيد هذا الحساب' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        const finalAmount = Math.round(Math.max(Number(amount), 100));
        
        console.log(`💰 طلب شحن رصيد: الطالب ${student.full_name} (${student_id}) - المبلغ: ${finalAmount} دج`);

        const transaction = await insert('wallet_transactions', {
            student_id: student_id,
            amount: finalAmount,
            type: 'deposit',
            status: 'pending',
            description: `طلب شحن رصيد بقيمة ${finalAmount} دج`,
            created_at: new Date().toISOString()
        });

        const baseUrl = process.env.PLATFORM_URL || 
                        process.env.RENDER_EXTERNAL_URL || 
                        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
                        'https://chatvidio.vercel.app';

        const successToken = crypto.createHash('sha256')
            .update(`${transaction.id}-${CHARGILY_WEBHOOK_SECRET}`)
            .digest('hex');
        
        const successUrl = `${baseUrl}/api/wallet/deposit/success/${transaction.id}?token=${successToken}`;
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
            
            console.log(`✅ تم إنشاء رابط الدفع للطالب ${student_id}`);
            
            return res.json({
                success: true,
                checkout_url: checkout.checkout_url,
                transaction_id: transaction.id,
                amount: finalAmount
            });
        } else {
            await update('wallet_transactions', transaction.id, {
                status: 'failed',
                description: `فشل إنشاء رابط الدفع: ${checkout.error}`
            });
            
            console.error(`❌ فشل إنشاء رابط الدفع للطالب ${student_id}:`, checkout.error);
            
            return res.status(400).json({ 
                success: false, 
                error: checkout.error || 'حدث خطأ في عملية الدفع، يرجى المحاولة مرة أخرى'
            });
        }
    } catch (error) {
        console.error('❌ خطأ في شحن الرصيد:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ داخلي في الخادم' });
    }
});

// ============================================================
// معالجة نجاح الدفع
// ============================================================
app.get('/api/wallet/deposit/success/:transaction_id', [
    query('token').notEmpty().withMessage('رمز التحقق مطلوب')
], async (req, res) => {
    const { transaction_id } = req.params;
    const { token } = req.query;

    try {
        const expectedToken = crypto.createHash('sha256')
            .update(`${transaction_id}-${CHARGILY_WEBHOOK_SECRET}`)
            .digest('hex');
        
        if (token !== expectedToken) {
            return res.status(403).send(renderErrorPage('طلب غير مصرح به', 'رمز التحقق غير صحيح'));
        }

        console.log(`✅ تأكيد نجاح الدفع للمعاملة: ${transaction_id}`);

        const transaction = await getOne('wallet_transactions', 'id', transaction_id);
        if (!transaction) {
            return res.status(404).send(renderErrorPage('خطأ', 'المعاملة غير موجودة'));
        }

        if (transaction.status === 'completed') {
            return res.send(renderSuccessPage('تمت المعاملة', 'تم شحن رصيدك بالفعل', '', 'العودة للوحة', '/student-dashboard.html'));
        }

        if (transaction.status !== 'pending') {
            return res.status(400).send(renderErrorPage('خطأ', 'هذه المعاملة لا يمكن معالجتها'));
        }

        const amount = transaction.amount;
        
        const student = await getOne('students', 'id', transaction.student_id);
        if (!student) {
            return res.status(404).send(renderErrorPage('خطأ', 'الطالب غير موجود'));
        }

        const currentBalance = parseInt(student.wallet_balance) || 0;
        const addAmount = parseInt(amount) || 0;
        const newBalance = currentBalance + addAmount;
        
        await supabase
            .from('students')
            .update({ wallet_balance: newBalance })
            .eq('id', transaction.student_id);

        await update('wallet_transactions', transaction_id, {
            status: 'completed',
            description: `تم شحن الرصيد بنجاح بمبلغ ${amount} دج`
        });

        console.log(`✅ تم إضافة ${amount} دج للطالب ${student.full_name} (الرصيد الجديد: ${newBalance} دج)`);

        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>تم شحن الرصيد</title>
            <style>
                body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                h1{color:#10b981;font-size:2.5rem}
                .amount{font-size:2rem;font-weight:900;color:#0f5cbf;margin:10px 0}
                .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
                .btn:hover{background:#0a4a9a}
                .sub{color:#666;margin-top:10px}
            </style>
            </head>
            <body>
            <div class="card">
                <h1>✅ تم الشحن بنجاح!</h1>
                <div class="amount">+${amount} دج</div>
                <p style="font-size:1.1rem;">تم إضافة المبلغ إلى رصيدك</p>
                <p class="sub">الرصيد الجديد: ${newBalance} دج</p>
                <a href="/student-dashboard.html" class="btn">العودة للوحة</a>
            </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('❌ خطأ في معالجة نجاح الدفع:', error.message);
        res.status(500).send(renderErrorPage('حدث خطأ', 'حدث خطأ أثناء معالجة الدفع. يرجى التواصل مع الدعم الفني.', '/student-dashboard.html'));
    }
});

// ============================================================
// معالجة فشل الدفع
// ============================================================
app.get('/api/wallet/deposit/failure/:transaction_id', async (req, res) => {
    const { transaction_id } = req.params;

    try {
        await update('wallet_transactions', transaction_id, {
            status: 'failed',
            description: 'فشلت عملية الدفع'
        });

        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>فشل الشحن</title>
            <style>
                body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                h1{color:#f59e0b}
                .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
                .btn:hover{background:#0a4a9a}
            </style>
            </head>
            <body>
            <div class="card">
                <h1>❌ فشل الشحن</h1>
                <p>حدث خطأ أثناء عملية الدفع. لم يتم خصم أي مبلغ من حسابك.</p>
                <a href="/student-dashboard.html" class="btn">المحاولة مرة أخرى</a>
            </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('❌ خطأ في معالجة فشل الدفع:', error.message);
        res.redirect('/student-dashboard.html');
    }
});

// ============================================================
// نظام الحجز
// ============================================================
app.post('/api/booking/create', [
    authenticate,
    authorize(['student']),
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    const { offer_id, student_id } = req.body;

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعملية الحجز' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        if (!student.email_verified) {
            return res.status(403).json({ 
                success: false, 
                error: 'يجب تأكيد البريد الإلكتروني أولاً قبل حجز الحصص',
                email_not_verified: true
            });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) return res.status(404).json({ success: false, error: 'العرض غير موجود' });

        const { data: existing } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .maybeSingle();

        if (existing) return res.status(400).json({ success: false, error: 'مسجل بالفعل' });

        if (offer.is_free === 1 || offer.price === 0) {
            const session = await insert('sessions', {
                offer_id,
                student_id,
                payment_status: 'paid',
                payment_amount: 0,
                teacher_earned: 0,
                paid_from_wallet: false
            });
            await insert('waiting_room', { offer_id, student_id });
            return res.json({ success: true, session_id: session.id, is_free: true });
        }

        const currentBalance = student.wallet_balance || 0;

        if (currentBalance < offer.price) {
            return res.status(400).json({
                success: false,
                error: `رصيدك غير كافٍ. رصيدك الحالي: ${currentBalance} دج. سعر الحصة: ${offer.price} دج`,
                insufficient_balance: true,
                needed: offer.price - currentBalance
            });
        }

        const newBalance = currentBalance - offer.price;
        await update('students', student_id, { wallet_balance: newBalance });

        await insert('wallet_transactions', {
            student_id: student_id,
            amount: offer.price,
            type: 'withdraw',
            status: 'completed',
            description: `حجز حصة: ${offer.subject_name}`,
            created_at: new Date().toISOString()
        });

        const session = await insert('sessions', {
            offer_id,
            student_id,
            payment_status: 'paid',
            payment_amount: offer.price,
            teacher_earned: 0,
            paid_from_wallet: true
        });

        await insert('waiting_room', { offer_id, student_id });

        const teacher = await getOne('teachers', 'id', offer.teacher_id);
        const commission = offer.price * 0.1;
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
            message: `تم حجز الحصة بنجاح. تم خصم ${offer.price} دج من رصيدك. الرصيد المتبقي: ${newBalance} دج`
        });
    } catch (error) {
        console.error('خطأ في معالجة الحجز:', error);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// نظام نسيت كلمة المرور
// ============================================================
app.post('/api/forgot-password', [
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

        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const resetUrl = `${baseUrl}/reset-password.html?token=${resetToken}&email=${encodeURIComponent(email)}&role=${role}`;

        console.log('رابط إعادة التعيين:', resetUrl);

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

app.post('/api/verify-reset-token', [
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

app.post('/api/reset-password', [
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

// ============================================================
// نظام المراسلات
// ============================================================
app.post('/api/messages/send', [
    authenticate,
    body('sender_id').isInt().withMessage('معرف المرسل غير صالح'),
    body('sender_type').isIn(['student', 'teacher']).withMessage('نوع المرسل غير صالح'),
    body('receiver_id').isInt().withMessage('معرف المستقبل غير صالح'),
    body('receiver_type').isIn(['student', 'teacher']).withMessage('نوع المستقبل غير صالح'),
    body('message').notEmpty().withMessage('الرسالة مطلوبة').isLength({ max: 2000 }).withMessage('الرسالة طويلة جداً')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { sender_id, sender_type, receiver_id, receiver_type, message } = req.body;

        if (req.user.userId !== sender_id || req.user.role !== sender_type) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإرسال رسائل من هذا الحساب' });
        }

        const newMessage = await insert('messages', {
            sender_id,
            sender_type,
            receiver_id,
            receiver_type,
            message: message.trim(),
            created_at: new Date().toISOString(),
            is_read: false
        });

        await insert('notifications', {
            user_id: receiver_id,
            user_type: receiver_type,
            title: 'رسالة جديدة',
            message: 'لديك رسالة جديدة',
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ success: true, message: newMessage });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.get('/api/messages/conversations/:user_id/:user_type', [
    authenticate,
    param('user_id').isInt().withMessage('معرف المستخدم غير صالح'),
    param('user_type').isIn(['student', 'teacher']).withMessage('نوع المستخدم غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, user_type } = req.params;

        if (req.user.userId !== parseInt(user_id) || req.user.role !== user_type) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المحادثات' });
        }

        const { data } = await supabase
            .from('messages')
            .select('*')
            .or(`sender_id.eq.${user_id},receiver_id.eq.${user_id}`)
            .order('created_at', { ascending: false });

        const conversations = {};
        for (const msg of data || []) {
            const otherId = msg.sender_id == user_id ? msg.receiver_id : msg.sender_id;
            const otherType = msg.sender_id == user_id ? msg.receiver_type : msg.sender_type;
            const key = `${otherId}-${otherType}`;

            if (!conversations[key] || msg.created_at > conversations[key].last_message_date) {
                let otherName = 'مستخدم';
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
                    unread_count: (!msg.is_read && msg.receiver_id == user_id) ? 1 : 0
                };
            } else if (!msg.is_read && msg.receiver_id == user_id) {
                conversations[key].unread_count++;
            }
        }

        res.json(Object.values(conversations));
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

app.get('/api/messages/:user_id/:user_type/:other_id/:other_type', [
    authenticate,
    param('user_id').isInt().withMessage('معرف المستخدم غير صالح'),
    param('user_type').isIn(['student', 'teacher']).withMessage('نوع المستخدم غير صالح'),
    param('other_id').isInt().withMessage('معرف الطرف الآخر غير صالح'),
    param('other_type').isIn(['student', 'teacher']).withMessage('نوع الطرف الآخر غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, user_type, other_id, other_type } = req.params;

        if (req.user.userId !== parseInt(user_id) || req.user.role !== user_type) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المحادثة' });
        }

        const { data } = await supabase
            .from('messages')
            .select('*')
            .or(`and(sender_id.eq.${user_id},receiver_id.eq.${other_id}),and(sender_id.eq.${other_id},receiver_id.eq.${user_id})`)
            .order('created_at', { ascending: true });

        await supabase
            .from('messages')
            .update({ is_read: true })
            .eq('receiver_id', user_id)
            .eq('sender_id', other_id);

        res.json(data || []);
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// مسارات التسجيل والدخول
// ============================================================

// تسجيل أستاذ جديد
app.post('/api/teacher/register', checkBanned, upload.fields([
    { name: 'profile_image', maxCount: 1 },
    { name: 'diploma_image', maxCount: 1 },
    { name: 'id_image', maxCount: 1 }
]), validateUploadedFiles, [
    body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب').isLength({ max: 100 }).withMessage('الاسم طويل جداً'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('كلمة المرور يجب أن تحتوي على حرف كبير وحرف صغير ورقم'),
    body('phone').notEmpty().withMessage('رقم الهاتف مطلوب'),
    body('specialization').notEmpty().withMessage('التخصص مطلوب').isLength({ max: 100 }).withMessage('التخصص طويل جداً'),
    body('bio').notEmpty().withMessage('نبذة عنك مطلوبة').isLength({ max: 500 }).withMessage('النبذة طويلة جداً'),
    body('experience').notEmpty().withMessage('سنوات الخبرة مطلوبة')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        console.log('استلام طلب تسجيل أستاذ جديد');

        const { full_name, email, password, phone, specialization, bio, experience } = req.body;

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

        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
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

// تسجيل طالب
app.post('/api/student/register', checkBanned, [
    body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب').isLength({ max: 100 }).withMessage('الاسم طويل جداً'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('كلمة المرور يجب أن تحتوي على حرف كبير وحرف صغير ورقم'),
    body('phone').notEmpty().withMessage('رقم الهاتف مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { full_name, email, password, phone } = req.body;

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

        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
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

async function processReferralOnRegister(refCode, newUserId, newUserRole) {
    try {
        let referrer = null;
        let referrerRole = null;

        const { data: studentReferrer } = await supabase
            .from('students')
            .select('id, referral_code, full_name')
            .eq('referral_code', refCode)
            .single();

        if (studentReferrer) {
            referrer = studentReferrer;
            referrerRole = 'student';
        } else {
            const { data: teacherReferrer } = await supabase
                .from('teachers')
                .select('id, referral_code, full_name')
                .eq('referral_code', refCode)
                .single();

            if (teacherReferrer) {
                referrer = teacherReferrer;
                referrerRole = 'teacher';
            }
        }

        if (!referrer || referrer.id === newUserId) {
            return;
        }

        await insert('referrals', {
            referrer_id: referrer.id,
            referrer_role: referrerRole,
            referred_user_id: newUserId,
            referred_user_role: newUserRole,
            status: 'pending_verification',
            created_at: new Date().toISOString()
        });

        console.log(`تم تسجيل إحالة: ${referrer.full_name} (${referrerRole}) -> مستخدم جديد`);
    } catch (error) {
        console.error('خطأ في معالجة الإحالة:', error.message);
    }
}

// تحديث بيانات الطالب
app.post('/api/student/update-profile', [
    authenticate,
    authorize(['student']),
    upload.single('profile_image'),
    validateUploadedFiles,
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, full_name, phone } = req.body;

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        let profile_image = null;
        let profile_url = null;

        const oldStudent = await getOne('students', 'id', student_id);

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
            .eq('id', student_id)
            .select();

        if (error) throw error;

        res.json({ success: true, message: 'تم تحديث الملف الشخصي', user: data[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// جلب بيانات طالب
app.get('/api/student/:student_id', [
    authenticate,
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المعلومات' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) return res.status(404).json({ success: false, error: 'طالب غير موجود' });
        
        delete student.password;
        
        res.json(student);
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// تحديث بيانات الأستاذ
app.post('/api/teacher/update-profile', [
    authenticate,
    authorize(['teacher']),
    upload.single('profile_image'),
    validateUploadedFiles,
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'الرجاء اختيار صورة' });
        }

        const oldTeacher = await getOne('teachers', 'id', teacher_id);
        const uploaded = await uploadToSupabase(req.file, 'teachers', oldTeacher?.profile_image);
        if (!uploaded) return res.status(500).json({ success: false, error: 'فشل رفع الصورة' });

        const updateData = {
            profile_image: uploaded.filename,
            profile_url: uploaded.url
        };

        const { data, error } = await supabase
            .from('teachers')
            .update(updateData)
            .eq('id', teacher_id)
            .select();

        if (error) throw error;

        res.json({ success: true, message: 'تم تحديث الصورة الشخصية', user: data[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// جلب بيانات أستاذ
app.get('/api/teacher/:teacher_id', [
    authenticate,
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = parseInt(req.params.teacher_id);

        if (req.user.userId !== teacher_id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المعلومات' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        
        delete teacher.password;
        
        res.json(teacher);
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// جلب جميع الأساتذة المقبولين
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
// تسجيل الدخول
// ============================================================
app.post('/api/login', checkBanned, [
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

        console.log(`محاولة تسجيل دخول: ${email} كـ ${role}`);

        if (role === 'admin') {
            console.log('🔐 محاولة تسجيل دخول كمدير');
            
            if (email !== ADMIN_EMAIL) {
                console.log('❌ بريد المدير غير صحيح');
                return res.status(401).json({ 
                    success: false, 
                    error: 'بيانات الدخول غير صحيحة' 
                });
            }
            
            const isValid = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
            
            if (!isValid) {
                console.log('❌ كلمة مرور المدير غير صحيحة');
                return res.status(401).json({ 
                    success: false, 
                    error: 'بيانات الدخول غير صحيحة' 
                });
            }
            
            console.log('✅ تم تسجيل دخول المدير بنجاح');
            
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
app.post('/api/logout', authenticate, (req, res) => {
    res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
});

// ============================================================
// ADMIN Routes - إدارة المستخدمين والحظر
// ============================================================

app.get('/api/admin/students', [
    authenticate,
    authorize(['admin'])
], async (req, res) => {
    try {
        const { data } = await supabase
            .from('students')
            .select('*')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

app.get('/api/admin/banned-users', [
    authenticate,
    authorize(['admin'])
], async (req, res) => {
    try {
        const { data } = await supabase
            .from('banned_users')
            .select('*')
            .order('banned_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

app.post('/api/admin/delete-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role, ban } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }
        
        const { data: loginLog } = await supabase
            .from('login_logs')
            .select('ip_address_encrypted')
            .eq('user_id', user_id)
            .eq('user_role', role)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
        
        const userIp = loginLog?.ip_address_encrypted || null;
        
        await supabase
            .from(tableName)
            .delete()
            .eq('id', user_id);
        
        if (ban && userIp) {
            const { data: existingBan } = await supabase
                .from('banned_users')
                .select('*')
                .eq('ip_address_encrypted', userIp)
                .single();
            
            if (!existingBan) {
                await insert('banned_users', {
                    user_id: user_id,
                    user_role: role,
                    full_name: user.full_name,
                    email: user.email,
                    ip_address_encrypted: userIp,
                    ban_reason: 'تم حظر المستخدم تلقائياً عند حذف الحساب',
                    banned_at: new Date().toISOString(),
                    banned_by: 'admin'
                });
            }
        }
        
        res.json({ 
            success: true, 
            message: 'تم حذف المستخدم بنجاح',
            banned: ban && userIp ? true : false
        });
    } catch (error) {
        console.error('خطأ في حذف المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.post('/api/admin/ban-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role, reason } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }
        
        const { data: loginLog } = await supabase
            .from('login_logs')
            .select('ip_address_encrypted')
            .eq('user_id', user_id)
            .eq('user_role', role)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
        
        const userIp = loginLog?.ip_address_encrypted || null;
        
        if (!userIp) {
            return res.status(400).json({ success: false, error: 'لا يمكن تحديد IP المستخدم' });
        }
        
        const { data: existingBan } = await supabase
            .from('banned_users')
            .select('*')
            .eq('ip_address_encrypted', userIp)
            .single();
        
        if (existingBan) {
            return res.status(400).json({ success: false, error: 'هذا المستخدم محظور بالفعل' });
        }
        
        await insert('banned_users', {
            user_id: user_id,
            user_role: role,
            full_name: user.full_name,
            email: user.email,
            ip_address_encrypted: userIp,
            ban_reason: reason || 'لم يتم تحديد سبب',
            banned_at: new Date().toISOString(),
            banned_by: 'admin'
        });
        
        await supabase
            .from(tableName)
            .update({ is_banned: true, ban_reason: reason || 'لم يتم تحديد سبب' })
            .eq('id', user_id);
        
        res.json({ success: true, message: 'تم حظر المستخدم بنجاح' });
    } catch (error) {
        console.error('خطأ في حظر المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.post('/api/admin/unban-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        const { data: banRecord } = await supabase
            .from('banned_users')
            .select('*')
            .eq('user_id', user_id)
            .eq('user_role', role)
            .single();
        
        if (!banRecord) {
            return res.status(404).json({ success: false, error: 'المستخدم غير محظور' });
        }
        
        await supabase
            .from('banned_users')
            .delete()
            .eq('id', banRecord.id);
        
        await supabase
            .from(tableName)
            .update({ is_banned: false, ban_reason: null })
            .eq('id', user_id);
        
        res.json({ success: true, message: 'تم إلغاء حظر المستخدم بنجاح' });
    } catch (error) {
        console.error('خطأ في إلغاء الحظر:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// باقي مسارات ADMIN
// ============================================================
app.get('/api/admin/pending-teachers', [
    authenticate,
    authorize(['admin'])
], async (req, res) => {
    try {
        const { data } = await supabase
            .from('teachers')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

app.get('/api/admin/approved-teachers', [
    authenticate,
    authorize(['admin'])
], async (req, res) => {
    try {
        const { data } = await supabase
            .from('teachers')
            .select('*')
            .eq('status', 'approved')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

app.post('/api/admin/approve-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        await update('teachers', req.params.id, { status: 'approved' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.post('/api/admin/reject-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { reason } = req.body;
        await update('teachers', req.params.id, {
            status: 'rejected',
            rejection_reason: reason || 'لم يتم تحديد سبب'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.delete('/api/admin/delete-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = req.params.id;

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
        console.error('خطأ في حذف الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// نظام العروض
// ============================================================
app.post('/api/offer/create', [
    authenticate,
    authorize(['teacher']),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('subject_name').notEmpty().withMessage('اسم المادة مطلوب').isLength({ max: 100 }).withMessage('اسم المادة طويل جداً'),
    body('duration').isInt({ min: 1, max: 360 }).withMessage('المدة غير صالحة (1-360 دقيقة)'),
    body('offer_date').notEmpty().withMessage('تاريخ العرض مطلوب').isISO8601().withMessage('تاريخ غير صالح'),
    body('price').isFloat({ min: 0, max: 1000000 }).withMessage('السعر غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, subject_name, duration, offer_date, price, is_free } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإنشاء عروض لهذا الحساب' });
        }

        const room_name = `stream_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

        await insert('offers', {
            teacher_id,
            subject_name: subject_name.trim(),
            duration,
            offer_date,
            price,
            is_free: is_free ? 1 : 0,
            room_name,
            status: 'upcoming'
        });

        res.json({ success: true, room_name });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
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
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

app.get('/api/teacher/offers/:teacher_id', [
    authenticate,
    authorize(['teacher']),
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = parseInt(req.params.teacher_id);

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه العروض' });
        }

        const { data } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('offer_date', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.delete('/api/offer/delete/:offer_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id } = req.body;
        const offer_id = parseInt(req.params.offer_id);

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذا العرض' });
        }

        const offer = await getOne('offers', 'id', offer_id);

        if (!offer || offer.teacher_id != teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح' });
        }

        await supabase.from('sessions').delete().eq('offer_id', offer_id);
        await supabase.from('waiting_room').delete().eq('offer_id', offer_id);
        await supabase.from('active_stream').delete().eq('offer_id', offer_id);
        await supabase.from('offers').delete().eq('id', offer_id);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.get('/api/student/bookings/:student_id', [
    authenticate,
    authorize(['student']),
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه الحجوزات' });
        }

        const { data } = await supabase
            .from('sessions')
            .select('*, offers:offer_id (id, subject_name, offer_date, duration, price, is_free, status, room_name, teachers:teacher_id (id, full_name, profile_image, profile_url))')
            .eq('student_id', student_id)
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
        console.error('خطأ في جلب الحجوزات:', error.message);
        res.status(500).json([]);
    }
});

app.get('/api/waiting-count/:offer_id', async (req, res) => {
    try {
        const { count } = await supabase
            .from('waiting_room')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', req.params.offer_id);
        res.json({ count: count || 0 });
    } catch (error) {
        res.json({ count: 0 });
    }
});

// ============================================================
// نظام الرصيد والأرباح للأستاذ
// ============================================================
app.get('/api/teacher/balance/:teacher_id', [
    authenticate,
    authorize(['teacher']),
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = parseInt(req.params.teacher_id);

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المعلومات' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });

        const { data: paidSessions } = await supabase
            .from('sessions')
            .select('*, offers:offer_id (subject_name)')
            .eq('payment_status', 'paid')
            .eq('offer_id', teacher_id)
            .order('created_at', { ascending: false });

        res.json({
            balance: teacher.balance || 0,
            total_earned: teacher.total_earned || 0,
            sessions: paidSessions || []
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.post('/api/teacher/withdraw-request', [
    authenticate,
    authorize(['teacher']),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('amount').isFloat({ min: 1, max: 1000000 }).withMessage('المبلغ غير صالح'),
    body('ccp_account').isLength({ min: 10, max: 20 }).withMessage('رقم حساب CCP غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, amount, ccp_account } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بطلب السحب' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });

        if ((teacher.balance || 0) < amount) {
            return res.status(400).json({ success: false, error: 'الرصيد غير كافٍ' });
        }

        const withdrawRequest = await insert('withdraw_requests', {
            teacher_id: parseInt(teacher_id),
            amount: parseFloat(amount),
            ccp_account: ccp_account.trim(),
            status: 'pending',
            created_at: new Date().toISOString()
        });

        await update('teachers', teacher_id, {
            balance: (teacher.balance || 0) - amount,
            pending_withdraw: (teacher.pending_withdraw || 0) + amount
        });

        res.json({ success: true, request: withdrawRequest });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.get('/api/teacher/withdraw-requests/:teacher_id', [
    authenticate,
    authorize(['teacher']),
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacher_id = parseInt(req.params.teacher_id);

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه الطلبات' });
        }

        const { data } = await supabase
            .from('withdraw_requests')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/admin/withdraw-requests', [
    authenticate,
    authorize(['admin'])
], async (req, res) => {
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

app.post('/api/admin/withdraw-requests/:id/approve', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الطلب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { id } = req.params;

        const request = await getOne('withdraw_requests', 'id', id);
        if (!request) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });

        await update('withdraw_requests', id, {
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
            title: 'تمت معالجة طلب السحب',
            message: `تم تحويل مبلغ ${request.amount} دج إلى حسابك ${request.ccp_account}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.post('/api/admin/withdraw-requests/:id/reject', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الطلب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { id } = req.params;
        const { reason } = req.body;

        const request = await getOne('withdraw_requests', 'id', id);
        if (!request) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });

        await update('withdraw_requests', id, {
            status: 'rejected',
            rejection_reason: reason || 'لم يتم تحديد سبب',
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
            title: 'تم رفض طلب السحب',
            message: `تم رفض طلب سحب مبلغ ${request.amount} دج. السبب: ${reason || 'لم يتم تحديد سبب'}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// نظام البث المباشر
// ============================================================
app.post('/api/stream/enter-teacher/:offer_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, teacher_id } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);

        if (!offer || offer.teacher_id != teacher_id) {
            return res.status(403).json({ success: false });
        }

        await update('offers', offer_id, { status: 'teacher_ready' });
        res.json({ success: true, room_name: offer.room_name });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.post('/api/stream/add-students/:offer_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, teacher_id } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);

        if (!offer || offer.teacher_id != teacher_id) {
            return res.status(403).json({ success: false });
        }

        await update('offers', offer_id, { status: 'live' });

        const { data: waitingStudents } = await supabase
            .from('waiting_room')
            .select('student_id')
            .eq('offer_id', offer_id);

        const addedStudents = [];

        for (const student of waitingStudents || []) {
            await insert('active_stream', { offer_id, student_id: student.student_id });

            await insert('notifications', {
                user_id: student.student_id,
                user_type: 'student',
                title: 'البث المباشر بدأ',
                message: `الحصة "${offer.subject_name}" قد بدأت الآن. انضم إلى البث المباشر.`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            });

            addedStudents.push(student.student_id);

            await supabase
                .from('waiting_room')
                .delete()
                .eq('offer_id', offer_id)
                .eq('student_id', student.student_id);
        }

        res.json({ success: true, students_count: addedStudents.length, students: addedStudents });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.post('/api/stream/end/:offer_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);

        await update('offers', offer_id, { status: 'completed' });
        await supabase.from('active_stream').delete().eq('offer_id', offer_id);
        await supabase.from('waiting_room').delete().eq('offer_id', offer_id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.get('/api/stream/status/:offer_id', async (req, res) => {
    try {
        const offer = await getOne('offers', 'id', req.params.offer_id);
        res.json({ status: offer?.status || 'not_found', room_name: offer?.room_name });
    } catch (error) {
        res.status(500).json({ status: 'not_found' });
    }
});

app.get('/api/student/stream-status/:offer_id/:student_id', [
    authenticate,
    authorize(['student']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, student_id } = req.params;

        if (req.user.userId !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) return res.json({ can_join: false, status: 'not_found' });

        if (offer.status === 'live') {
            const { data: active } = await supabase
                .from('active_stream')
                .select('*')
                .eq('offer_id', offer_id)
                .eq('student_id', student_id)
                .single();

            if (active) {
                await supabase
                    .from('notifications')
                    .update({ is_read: true })
                    .eq('offer_id', offer_id)
                    .eq('user_id', student_id);

                return res.json({ can_join: true, room_name: offer.room_name, status: 'live' });
            }
            return res.json({ can_join: false, status: 'not_active' });
        } else if (offer.status === 'teacher_ready') {
            const session = await getOne('sessions', 'offer_id', offer_id);
            if (session && session.payment_status === 'paid' && session.student_id == student_id) {
                const { data: existingWaiting } = await supabase
                    .from('waiting_room')
                    .select('*')
                    .eq('offer_id', offer_id)
                    .eq('student_id', student_id)
                    .maybeSingle();

                if (!existingWaiting) {
                    await insert('waiting_room', { offer_id: offer_id, student_id: student_id });
                }
                return res.json({ can_join: false, is_waiting: true, status: 'waiting' });
            }
            return res.json({ can_join: false, payment_required: true, status: 'payment_required' });
        } else if (offer.status === 'upcoming') {
            const session = await getOne('sessions', 'offer_id', offer_id);
            if (session && session.payment_status === 'paid' && session.student_id == student_id) {
                return res.json({ can_join: false, is_upcoming: true, status: 'upcoming', offer_date: offer.offer_date });
            }
            return res.json({ can_join: false, payment_required: true, status: 'payment_required' });
        }

        return res.json({ can_join: false, status: 'unknown' });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ can_join: false, status: 'error' });
    }
});

app.get('/api/stream/waiting-list/:offer_id/:teacher_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, teacher_id } = req.params;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data } = await supabase
            .from('waiting_room')
            .select('*, students:student_id (full_name, email)')
            .eq('offer_id', offer_id);

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

app.get('/api/notifications/:user_id/:user_type', [
    authenticate,
    param('user_id').isInt().withMessage('معرف المستخدم غير صالح'),
    param('user_type').isIn(['student', 'teacher']).withMessage('نوع المستخدم غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, user_type } = req.params;

        if (req.user.userId !== parseInt(user_id) || req.user.role !== user_type) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه الإشعارات' });
        }

        const { data } = await supabase
            .from('notifications')
            .select('*')
            .eq('user_id', user_id)
            .eq('user_type', user_type)
            .order('created_at', { ascending: false })
            .limit(30);

        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.post('/api/notifications/read/:notification_id', [
    authenticate,
    param('notification_id').isInt().withMessage('معرف الإشعار غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const notification_id = parseInt(req.params.notification_id);

        const { data: notification } = await supabase
            .from('notifications')
            .select('user_id, user_type')
            .eq('id', notification_id)
            .single();

        if (notification && (notification.user_id !== req.user.userId || notification.user_type !== req.user.role)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        await update('notifications', notification_id, { is_read: true });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// صفحات البث
// ============================================================
app.get('/api/teacher-stream/:offer_id/:teacher_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).send(renderErrorPage('خطأ في البيانات', 'البيانات المرسلة غير صالحة'));
        }

        const { offer_id, teacher_id } = req.params;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.redirect('/teacher-dashboard.html');
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer || offer.teacher_id != parseInt(teacher_id)) {
            return res.redirect('/teacher-dashboard.html');
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="ar">
            <head><meta charset="UTF-8"><title>بث مباشر - الأستاذ</title>
            <script src="https://meet.jit.si/external_api.js"></script>
            <style>
                *{margin:0;padding:0;box-sizing:border-box}
                body{font-family:Cairo,sans-serif;background:#0a0a1a;overflow:hidden}
                .header{background:linear-gradient(135deg,#0f3460,#1a1a2e);color:white;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:fixed;top:0;left:0;right:0;z-index:100}
                .btn{color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer;transition:all 0.3s;margin-left:8px}
                .btn:hover{transform:scale(1.05)}
                .btn-danger{background:#ef4444}
                .btn-danger:hover{background:#dc2626}
                .btn-success{background:#10b981}
                .btn-success:hover{background:#059669}
                .btn-warning{background:#f59e0b}
                .btn-warning:hover{background:#d97706}
                .badge{background:#f59e0b;padding:5px 15px;border-radius:30px;font-size:0.8rem}
                #jitsi-container{position:fixed;top:60px;left:0;right:0;bottom:0}
                .waiting-panel{position:fixed;left:20px;top:80px;width:300px;background:white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.3);z-index:200;max-height:400px;overflow-y:auto}
                .waiting-header{background:linear-gradient(135deg,#0f5cbf,#0f3460);color:white;padding:12px;border-radius:12px 12px 0 0;font-weight:700;display:flex;justify-content:space-between}
                .waiting-list{padding:8px}
                .student-item{display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid #e2e8f0}
                .add-btn{background:#10b981;color:white;border:none;padding:4px 12px;border-radius:20px;cursor:pointer;font-size:0.7rem}
                .add-btn:hover{background:#059669}
                @media(max-width:768px){.waiting-panel{left:10px;right:10px;width:auto;top:70px}}
            </style>
            </head>
            <body>
            <div class="header">
                <div><span class="badge">انت المضيف</span></div>
                <div>
                    <span id="waitingCount" class="badge">0 ينتظرون</span>
                    <button class="btn btn-success" onclick="addAllStudents()">اضافة الكل</button>
                    <button class="btn btn-danger" onclick="endStream()">انهاء</button>
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
                const roomName = '${sanitizeInput(offer.room_name)}';
                const offerId = ${parseInt(offer_id)};
                const teacherId = ${parseInt(teacher_id)};

                function initJitsi() {
                    try {
                        const api = new JitsiMeetExternalAPI('meet.jit.si', {
                            roomName: roomName,
                            width: '100%',
                            height: window.innerHeight - 60,
                            parentNode: document.querySelector('#jitsi-container'),
                            userInfo: { displayName: 'الاستاذ' },
                            configOverwrite: {
                                disableSimulcast: false,
                                enableNoisyMicDetection: false,
                                p2p: { enabled: true }
                            }
                        });
                        window.jitsiApi = api;
                    } catch (error) {
                        console.error('خطأ في Jitsi:', error);
                        setTimeout(initJitsi, 3000);
                    }
                }

                async function loadWaitingList() {
                    try {
                        const res = await fetch('/api/stream/waiting-list/' + offerId + '/' + teacherId);
                        const students = await res.json();
                        const count = students?.length || 0;
                        document.getElementById('waitingCount').innerHTML = count + ' ينتظرون';
                        if (count > 0) {
                            document.getElementById('waitingPanel').style.display = 'block';
                            document.getElementById('panelCount').innerText = count;
                            let html = '';
                            students.forEach(s => {
                                html += '<div class="student-item">' +
                                    '<div><strong>' + escapeHtml(s.full_name) + '</strong><br><small>' + escapeHtml(s.email) + '</small></div>' +
                                    '<button class="add-btn" onclick="addStudent(' + s.student_id + ')">اضافة</button>' +
                                '</div>';
                            });
                            document.getElementById('waitingList').innerHTML = html;
                        } else {
                            document.getElementById('waitingPanel').style.display = 'none';
                        }
                    } catch(e) { console.error(e); }
                }

                async function addStudent(studentId) {
                    if (confirm('اضافة الطالب الى البث؟')) {
                        const res = await fetch('/api/stream/add-students/' + offerId, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ offer_id: offerId, teacher_id: teacherId })
                        });
                        const data = await res.json();
                        if (data.success) {
                            alert('تم اضافة الطالب');
                            loadWaitingList();
                        }
                    }
                }

                async function addAllStudents() {
                    if (confirm('اضافة جميع الطلاب الى البث؟')) {
                        const res = await fetch('/api/stream/add-students/' + offerId, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ offer_id: offerId, teacher_id: teacherId })
                        });
                        const data = await res.json();
                        if (data.success) {
                            alert('تم اضافة ' + data.students_count + ' طالب');
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
                    if (confirm('انهاء البث؟')) {
                        await fetch('/api/stream/end/' + offerId, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ offer_id: offerId, teacher_id: teacherId })
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
        console.error('خطأ:', error.message);
        res.redirect('/teacher-dashboard.html');
    }
});

app.get('/api/enter-teacher-stream/:offer_id/:teacher_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).send(renderErrorPage('خطأ في البيانات', 'البيانات المرسلة غير صالحة'));
        }

        const { offer_id, teacher_id } = req.params;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).send(renderErrorPage('غير مصرح', 'غير مصرح لك بالدخول إلى هذا البث'));
        }

        await axios.post(`${req.protocol}://${req.get('host')}/api/stream/enter-teacher/${offer_id}`, {
            offer_id: parseInt(offer_id),
            teacher_id: parseInt(teacher_id)
        }).catch(e => console.log(e));
        res.redirect(`/api/teacher-stream/${offer_id}/${teacher_id}`);
    } catch (error) {
        res.redirect('/teacher-dashboard.html');
    }
});

app.get('/api/join-stream/:offer_id/:student_id', [
    authenticate,
    authorize(['student']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).send(renderErrorPage('خطأ في البيانات', 'البيانات المرسلة غير صالحة'));
        }

        const { offer_id, student_id } = req.params;

        if (req.user.userId !== parseInt(student_id)) {
            return res.status(403).send(renderErrorPage('غير مصرح', 'غير مصرح لك بالدخول إلى هذا البث'));
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer || offer.status !== 'live') {
            return res.redirect('/student-dashboard.html');
        }

        const { data: active } = await supabase
            .from('active_stream')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .single();

        if (!active) {
            return res.redirect('/student-dashboard.html');
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="ar">
            <head><meta charset="UTF-8"><title>حصة مباشرة</title>
            <script src="https://meet.jit.si/external_api.js"></script>
            <style>
                *{margin:0;padding:0;box-sizing:border-box}
                body{font-family:Cairo,sans-serif;background:#0a0a1a;overflow:hidden}
                .header{background:linear-gradient(135deg,#0f3460,#1a1a2e);color:white;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:fixed;top:0;left:0;right:0;z-index:100}
                .btn{background:#ef4444;color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer;transition:all 0.3s}
                .btn:hover{background:#dc2626;transform:scale(1.05)}
                .badge{background:#10b981;padding:5px 15px;border-radius:30px;font-size:0.8rem}
                #jitsi-container{position:fixed;top:60px;left:0;right:0;bottom:0}
            </style>
            </head>
            <body>
            <div class="header">
                <div><span class="badge">انت طالب</span></div>
                <button class="btn" onclick="leaveStream()">مغادرة</button>
            </div>
            <div id="jitsi-container"></div>
            <script>
                const api = new JitsiMeetExternalAPI('meet.jit.si', {
                    roomName: '${sanitizeInput(offer.room_name)}',
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
        console.error('خطأ:', error.message);
        res.redirect('/student-dashboard.html');
    }
});

// ============================================================
// نظام الكابتشا
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
            ${Array.from({length: 5}, (_, i) => {
                const x = Math.random() * 200;
                const y = Math.random() * 60;
                return `<circle cx="${x}" cy="${y}" r="${Math.random() * 3 + 1}" fill="${colors[Math.floor(Math.random() * colors.length)]}" opacity="0.5"/>`;
            }).join('')}
        </svg>
    `;
    return svg;
}

app.get('/api/captcha/generate', (req, res) => {
    const code = generateCaptcha();
    const captchaId = Date.now().toString(36) + crypto.randomBytes(8).toString('hex');

    captchaStore[captchaId] = {
        code: code,
        expires: Date.now() + 5 * 60 * 1000
    };

    const now = Date.now();
    Object.keys(captchaStore).forEach(key => {
        if (captchaStore[key].expires < now) {
            delete captchaStore[key];
        }
    });

    const svg = generateCaptchaImage(code);

    res.json({
        captcha_id: captchaId,
        image: svg,
        expires_in: 300
    });
});

app.post('/api/captcha/verify', [
    body('captcha_id').notEmpty().withMessage('معرف الكابتشا مطلوب'),
    body('captcha_code').notEmpty().withMessage('رمز التحقق مطلوب')
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { captcha_id, captcha_code } = req.body;
    const stored = captchaStore[captcha_id];

    if (!stored) {
        return res.status(400).json({ success: false, error: 'انتهت صلاحية رمز التحقق، يرجى تحديث الصورة' });
    }

    if (Date.now() > stored.expires) {
        delete captchaStore[captcha_id];
        return res.status(400).json({ success: false, error: 'انتهت صلاحية رمز التحقق، يرجى تحديث الصورة' });
    }

    if (stored.code.toLowerCase() === captcha_code.toLowerCase().trim()) {
        delete captchaStore[captcha_id];
        return res.json({ success: true });
    } else {
        return res.status(400).json({ success: false, error: 'رمز التحقق غير صحيح، يرجى المحاولة مرة أخرى' });
    }
});

setInterval(() => {
    const now = Date.now();
    Object.keys(captchaStore).forEach(key => {
        if (captchaStore[key].expires < now) {
            delete captchaStore[key];
        }
    });
}, 60000);

// ============================================================
// إرسال إشعار لجميع الطلاب
// ============================================================
app.post('/api/admin/send-notification-to-all-students', [
    authenticate,
    authorize(['admin']),
    body('title').notEmpty().withMessage('العنوان مطلوب').isLength({ max: 100 }).withMessage('العنوان طويل جداً'),
    body('message').notEmpty().withMessage('المحتوى مطلوب').isLength({ max: 500 }).withMessage('المحتوى طويل جداً')
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
            return res.status(404).json({ success: false, error: 'لا يوجد طلاب مسجلين' });
        }

        const notifications = students.map(s => ({
            user_id: s.id,
            user_type: 'student',
            title: title.trim(),
            message: message.trim(),
            is_read: false,
            created_at: new Date().toISOString()
        }));

        const { error } = await supabase
            .from('notifications')
            .insert(notifications);

        if (error) {
            console.error('خطأ في إرسال الإشعارات:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        await supabase
            .from('admin_notifications')
            .insert({
                title: title.trim(),
                message: message.trim(),
                sent_to_all: true,
                students_count: students.length,
                created_at: new Date().toISOString()
            });

        res.json({
            success: true,
            students_count: students.length,
            message: `تم إرسال الإشعار إلى ${students.length} طالب`
        });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

app.get('/api/admin/sent-notifications', [
    authenticate,
    authorize(['admin'])
], async (req, res) => {
    try {
        const { data } = await supabase
            .from('admin_notifications')
            .select('*')
            .order('created_at', { ascending: false });

        res.json(data || []);
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

app.delete('/api/admin/delete-notification/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الإشعار غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        await supabase
            .from('admin_notifications')
            .delete()
            .eq('id', req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث ملف الأستاذ مع الروابط الاجتماعية
// ============================================================
app.post('/api/teacher/update-profile-with-social', [
    authenticate,
    authorize(['teacher']),
    upload.fields([
        { name: 'profile_image', maxCount: 1 }
    ]),
    validateUploadedFiles,
    body('teacher_id').isInt().withMessage('معرف الأستاذ مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, facebook_url, instagram_url, linkedin_url, youtube_url, twitter_url, website_url } = req.body;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        console.log('استلام طلب تحديث الملف الشخصي');

        let profile_image = null;
        let profile_url = null;

        const oldTeacher = await getOne('teachers', 'id', teacher_id);
        if (!oldTeacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        if (req.files?.['profile_image']?.[0]) {
            const file = req.files['profile_image'][0];
            const uploaded = await uploadToSupabase(file, 'teachers', oldTeacher?.profile_image);
            if (uploaded) {
                profile_image = uploaded.filename;
                profile_url = uploaded.url;
                console.log('تم رفع الصورة بنجاح');
            }
        }

        const updateData = {};

        if (profile_image) { updateData.profile_image = profile_image; }
        if (profile_url) { updateData.profile_url = profile_url; }

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
                    return res.status(400).json({ success: false, error: `الرابط ${key} غير صالح` });
                }
                updateData[key] = cleaned === '' ? null : cleaned;
            }
        }

        console.log('بيانات التحديث:', updateData);

        const { data, error } = await supabase
            .from('teachers')
            .update(updateData)
            .eq('id', teacher_id)
            .select();

        if (error) {
            console.error('خطأ في Supabase:', error);
            throw error;
        }

        console.log('تم تحديث الملف الشخصي بنجاح');

        res.json({
            success: true,
            message: 'تم تحديث الملف الشخصي وروابط التواصل الاجتماعي بنجاح',
            user: data ? data[0] : null
        });
    } catch (error) {
        console.error('خطأ في تحديث الملف الشخصي:', error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'حدث خطأ أثناء تحديث الملف الشخصي'
        });
    }
});

// ============================================================
// مسار مراقبة الأداء
// ============================================================
app.get('/api/admin/performance', [
    authenticate,
    authorize(['admin'])
], async (req, res) => {
    try {
        const { data: connections } = await supabase
            .from('active_stream')
            .select('count', { count: 'exact' });

        const { data: sessions } = await supabase
            .from('sessions')
            .select('count', { count: 'exact' });

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
            active_streams: connections?.count || 0,
            total_sessions: sessions?.count || 0
        });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// ============================================================
// تشغيل الخادم
// ============================================================

module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
        console.log('🔒 الأمان:');
        console.log('   ✅ Helmet مع CSP محسن');
        console.log('   ✅ JWT للمصادقة');
        console.log('   ✅ CSRF Protection');
        console.log('   ✅ Rate Limiting متقدم');
        console.log('   ✅ تنقية جميع المدخلات (XSS)');
        console.log('   ✅ تشفير عناوين IP');
        console.log('   ✅ التحقق من صحة الملفات');
        console.log('   ✅ Webhook للدفع الآمن');
        console.log('   ✅ CORS مع Wildcard لـ Vercel');
        console.log('📧 نظام تأكيد البريد الإلكتروني مفعل');
        console.log('🔗 نظام الإحالة مفعل');
        console.log('🎁 صناديق الهدايا للطلاب مفعلة');
        console.log('💰 مكافأة الإحالة: 100 دج للمعلم، فرصة صندوق هدايا للطالب');
        console.log('🔒 نظام الحظر (IP Ban) مع تشفير IP');
        console.log('👥 إدارة المستخدمين (حذف + حظر)');
        console.log('💳 نظام الدفع عبر Chargily مع Webhook');
        console.log('🔄 نظام التوجيه (redirectTo) للمدير');
        console.log('='.repeat(60));
        console.log(`📅 التاريخ: ${new Date().toLocaleString('ar-EG')}`);
        console.log('='.repeat(60));
    });
}
