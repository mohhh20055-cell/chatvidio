// ============================================================
// خادم منصة التعليم - الملف الرئيسي (معدل بالكامل - Jitsi Meet فقط)
// ============================================================

require('dotenv').config();

// دعم WebSocket على Node.js < 22 (يحتاجه Supabase realtime-js)
if (typeof global.WebSocket === 'undefined') {
    global.WebSocket = require('ws');
}

const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ============================================================
// الثوابت والإعدادات الأساسية
// ============================================================

const JWT_SECRET = process.env.JWT_SECRET || 'zoomdz_secret_key_2024_for_testing_only';
const JWT_EXPIRY = '24h';
const SALT_ROUNDS = 12;
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'https://chatvidio.vercel.app';

// قراءة المتغيرات البيئية
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
const recaptchaSiteKey = process.env.RECAPTCHA_SITE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ خطأ: متغيرات Supabase غير موجودة');
    process.exit(1);
}

if (!resendApiKey) {
    console.error('❌ خطأ: متغير RESEND_API_KEY غير موجود');
    process.exit(1);
}

// تهيئة الاتصالات
const supabase = createClient(supabaseUrl, supabaseKey);
const resend = new Resend(resendApiKey);

// ✅ إنشاء ملف config.js العام لتكوين الواجهة الأمامية
const fs = require('fs');
const publicDir = path.join(__dirname, 'public');
const configJsPath = path.join(publicDir, 'config.js');
try {
    fs.writeFileSync(configJsPath, `window.RECAPTCHA_SITE_KEY = ${JSON.stringify(recaptchaSiteKey || '')};\nwindow.API_BASE_URL = ${JSON.stringify(process.env.API_BASE_URL || '')};\n`);
} catch (e) {
    console.error('❌ خطأ في كتابة config.js:', e.message);
}

// ============================================================
// دوال مساعدة عامة
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

function encrypt(text) {
    if (!text) return null;
    try {
        const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
        const ENCRYPTION_IV = process.env.ENCRYPTION_IV || crypto.randomBytes(16).toString('hex');
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), Buffer.from(ENCRYPTION_IV, 'hex'));
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    } catch (error) {
        console.error('خطأ في التشفير:', error.message);
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
        return input.trim();
    }
    return input;
}

function sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Buffer.isBuffer(obj)) return obj;
    if (obj instanceof Date) return obj;
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

function generateVerificationToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateReferralCode(name, id) {
    const prefix = name.substring(0, 3).toUpperCase();
    const suffix = id.toString(36).toUpperCase();
    return `${prefix}${suffix}`;
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
// إعدادات CORS
// ============================================================

const CORS_ORIGIN = process.env.CORS_ORIGIN 
    ? process.env.CORS_ORIGIN.split(',') 
    : [
        'https://chatvidio.vercel.app',
        'https://chatvidio.onrender.com',
        'https://chatvidio-git-*.vercel.app',
        'https://chatvidio-*.vercel.app',
        'https://*.vercel.app',
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002'
    ];

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
// تهيئة التطبيق
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);

// ============================================================
// Middleware الأساسية
// ============================================================

// Compression
app.use(compression());

// Helmet - Jitsi Meet فقط
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdnjs.cloudflare.com", "https://vercel.live", "https://*.vercel.app", "https://www.google.com", "https://www.gstatic.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://ui-avatars.com", "https://api.qrserver.com", "https://*.supabase.co", "https://www.google.com", "https://www.gstatic.com"],
            connectSrc: ["'self'", "https://*.supabase.co", "https://pay.chargily.net", "https://*.vercel.app", "https://www.google.com", "https://www.gstatic.com"],
            frameSrc: ["'self'", "https://meet.jit.si", "https://www.google.com", "https://www.gstatic.com"]
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

// CORS
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

// Cookie Parser
app.use(cookieParser());

// Webhook Chargily (يجب استقباله كـ raw body قبل JSON parser)
app.use('/api/wallet/chargily-webhook', express.raw({ type: 'application/json' }));

// JSON و URL-encoded
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

// ملفات ثابتة
app.use(express.static('public', {
    maxAge: '1d',
    etag: true,
    lastModified: true
}));

// ============================================================
// Middleware المصادقة (معرفة محلياً)
// ============================================================

async function authenticate(req, res, next) {
    let token = req.headers.authorization?.substring(7);
    if (!token && req.query.token) {
        token = req.query.token;
    }
    
    if (!token) {
        return res.status(401).json({ success: false, error: 'غير مصرح به، يرجى تسجيل الدخول' });
    }

    const decoded = verifyToken(token);
    
    if (!decoded) {
        return res.status(401).json({ success: false, error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مرة أخرى' });
    }

    req.user = decoded;
    req.token = token;
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
// CSRF Protection
// ============================================================

const csrfExcludedPaths = [
    '/api/login',
    '/api/student/register',
    '/api/teacher/register',
    '/api/forgot-password',
    '/api/reset-password',
    '/api/verify-reset-token',
    '/api/verify-email',
    '/api/resend-verification',
    '/api/csrf-token',
    '/api/get-csrf-token',
    '/api/public/teachers',
    '/api/public/offers',
    '/api/public/stats',
    '/api/public/students-count',
    '/api/public/teacher',
    '/api/public/total-offers',
    '/api/live-offers',
    '/api/offers',
    '/api/teachers',
    '/api/test-cors',
    '/api/ping',
    '/api/verify-token',
    '/api/refresh-token',
    '/api/stream/save-link',
    '/api/stream/add-student',
    '/api/stream/add-all-students',
    '/api/stream/add-students',
    '/api/stream/waiting-list',
    '/api/stream/status',
    '/api/student/stream-status',
    '/api/join-stream',
    '/api/teacher-start-stream',
    '/api/teacher-stream',
    '/api/referral',
    '/api/referral/create',
    '/api/wallet/chargily-webhook',
    '/api/chargily-webhook',
    '/api/start-jitsi-stream',
    '/api/join-jitsi'
];

app.use((req, res, next) => {
    const publicMethods = ['GET', 'HEAD', 'OPTIONS'];
    
    const isPublicPath = csrfExcludedPaths.some(path => {
        if (path === req.path) return true;
        if (req.path.startsWith(path + '/')) return true;
        return false;
    });
    
    const isPublicMethod = publicMethods.includes(req.method);
    
    if (isPublicPath || isPublicMethod) {
        return next();
    }
    
    const csrfToken = req.headers['x-csrf-token'];
    const cookieToken = req.cookies.csrf_token;
    
    if (!csrfToken || !cookieToken || csrfToken !== cookieToken) {
        console.log(`❌ CSRF فشل: ${req.path}`);
        return res.status(403).json({ 
            success: false, 
            error: 'طلب غير مصرح به (CSRF)',
            code: 'CSRF_ERROR'
        });
    }
    
    next();
});

// ============================================================
// Rate Limiting
// ============================================================

const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'عدد محاولات تسجيل الدخول كبير جداً، حاول بعد ساعة' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.body && req.body.email) {
            return req.body.email;
        }
        return req.ip || req.connection?.remoteAddress || 'unknown';
    }
});

// ============================================================
// CSRF Token Generator
// ============================================================

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

app.get('/api/get-csrf-token', authenticate, (req, res) => {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie('csrf_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000
    });
    res.json({ csrfToken: token });
});

// ============================================================
// ✅ نظام البث المباشر باستخدام Jitsi Meet فقط (مجاني 100%)
// ============================================================

// ============================================================
// ✅ بدء البث باستخدام Jitsi Meet
// ============================================================

app.post('/api/start-jitsi-stream', authenticate, authorize(['teacher']), [
    require('express-validator').body('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = require('express-validator').validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id } = req.body;
        
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }
        
        // ✅ إنشاء غرفة Jitsi
        const roomName = `zoomdz_${offer_id}_${Date.now()}`;
        const password = crypto.randomBytes(6).toString('hex').toUpperCase();
        const roomUrl = `https://meet.jit.si/${roomName}`;
        
        // ✅ حفظ بيانات البث في جدول العروض مباشرة
        await supabase
            .from('offers')
            .update({
                stream_url: roomUrl,
                stream_platform: 'jitsi',
                status: 'live',
                room_name: roomName,
                room_password: password,
                stream_started_at: new Date().toISOString()
            })
            .eq('id', offer_id);
        
        // ✅ إرسال إشعارات للطلاب
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');
        
        if (sessions && sessions.length > 0) {
            const notifications = sessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '🔴 البث المباشر بدأ',
                message: `الحصة "${offer.subject_name}" قد بدأت الآن. انضم عبر زر البث المباشر.`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            }));
            
            await supabase
                .from('notifications')
                .insert(notifications);
        }
        
        res.json({
            success: true,
            room_url: roomUrl,
            password: password,
            room_name: roomName,
            message: 'تم بدء البث بنجاح عبر Jitsi Meet (مجاني 100%)'
        });
    } catch (error) {
        console.error('❌ خطأ في بدء البث:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ التحقق من كلمة مرور Jitsi
// ============================================================

app.post('/api/verify-jitsi-password', async (req, res) => {
    try {
        const { room_name, password } = req.body;

        const { data } = await supabase
            .from('offers')
            .select('room_password')
            .eq('room_name', room_name)
            .single();

        if (data && data.room_password === password) {
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'كلمة المرور غير صحيحة' });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ صفحة دخول الطالب للبث (Jitsi Meet فقط)
// ============================================================

app.get('/api/join-jitsi/:offer_id', authenticate, async (req, res) => {
    try {
        const token = req.query.token;
        const decoded = verifyToken(token);
        if (!decoded || decoded.role !== 'student') {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const { offer_id } = req.params;
        const studentId = decoded.userId;
        
        // ✅ التحقق من الحجز المدفوع
        const session = await getOne('sessions', 'offer_id', offer_id);
        if (!session || session.student_id !== studentId || session.payment_status !== 'paid') {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ يجب حجز الحصة أولاً</h1>
                    <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }
        
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer || offer.status !== 'live') {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#f59e0b;">⏳ البث لم يبدأ بعد</h1>
                    <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }
        
        // ✅ عرض صفحة دخول Jitsi
        res.send(generateJitsiJoinPage(offer));
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head><meta charset="UTF-8"><title>خطأ</title></head>
            <body style="font-family:Cairo;text-align:center;padding:50px;">
                <h1 style="color:#ef4444;">❌ حدث خطأ</h1>
                <p style="color:#64748b;">${error.message}</p>
                <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
            </body></html>
        `);
    }
});

// ============================================================
// ✅ دالة توليد صفحة دخول Jitsi للطالب
// ============================================================

function generateJitsiJoinPage(offer) {
    const roomUrl = offer.stream_url || '';
    const password = offer.room_password || '';
    const subjectName = offer.subject_name || 'غير محدد';
    
    return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>دخول البث المباشر - Jitsi Meet</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Cairo', sans-serif; background: #0a0a1a; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { max-width: 450px; width: 90%; background: #1a1a2e; border-radius: 24px; padding: 40px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
        h1 { color: #0f5cbf; font-size: 1.5rem; margin-bottom: 10px; }
        .subtitle { color: #94a3b8; font-size: 0.9rem; margin-bottom: 20px; }
        .password-box { background: #0f3460; padding: 20px; border-radius: 12px; margin: 20px 0; border: 2px dashed rgba(96, 165, 250, 0.3); }
        .password-box span { color: #60a5fa; font-size: 2.2rem; font-weight: 900; letter-spacing: 8px; font-family: 'Courier New', monospace; }
        .password-label { color: #94a3b8; font-size: 0.8rem; margin-bottom: 8px; }
        .btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 16px 30px; border-radius: 12px; font-size: 1.1rem; font-weight: 700; cursor: pointer; width: 100%; transition: all 0.3s; margin-top: 20px; display: flex; align-items: center; justify-content: center; gap: 10px; }
        .btn:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(16, 185, 129, 0.4); }
        .info { color: #64748b; font-size: 0.8rem; margin-top: 16px; line-height: 1.6; }
        .info i { color: #f59e0b; }
        .copy-btn { background: transparent; border: 1px solid #333; color: #94a3b8; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 0.8rem; transition: all 0.3s; margin-top: 8px; }
        .copy-btn:hover { background: #1a1a2e; border-color: #0f5cbf; color: white; }
        .warning { color: #f59e0b; font-size: 0.75rem; margin-top: 10px; }
        .jitsi-badge { display: inline-block; background: #0f3460; padding: 4px 16px; border-radius: 20px; font-size: 0.7rem; color: #60a5fa; margin-bottom: 10px; border: 1px solid #0f5cbf; }
    </style>
</head>
<body>
    <div class="container">
        <div class="jitsi-badge"><i class="fas fa-video"></i> Jitsi Meet</div>
        <h1>🎥 ${escapeHtml(subjectName)}</h1>
        <p class="subtitle">🔐 أدخل كلمة المرور للدخول إلى البث المباشر</p>
        
        <div class="password-box">
            <div class="password-label">🔑 كلمة مرور البث</div>
            <span id="roomPassword">${password}</span>
            <br>
            <button class="copy-btn" onclick="copyPassword()">
                <i class="fas fa-copy"></i> نسخ كلمة المرور
            </button>
        </div>
        
        <button class="btn" onclick="joinJitsi()">
            <i class="fas fa-video"></i> فتح البث المباشر (Jitsi Meet)
        </button>
        
        <p class="info">
            <i class="fas fa-info-circle"></i> سيتم فتح Jitsi Meet في نافذة جديدة<br>
            ⚠️ أدخل كلمة المرور أعلاه عند الطلب<br>
            ✅ مجاني 100% ولا يحتاج إلى تثبيت
        </p>
        <p class="warning">
            ⚠️ لا تشارك كلمة المرور مع أي شخص خارج الحصة
        </p>
    </div>
    
    <script>
        const roomUrl = '${roomUrl}';
        const password = '${password}';
        
        function copyPassword() {
            navigator.clipboard.writeText(password).then(() => {
                const btn = document.querySelector('.copy-btn');
                btn.innerHTML = '✅ تم النسخ';
                setTimeout(() => {
                    btn.innerHTML = '<i class="fas fa-copy"></i> نسخ كلمة المرور';
                }, 2000);
            });
        }
        
        function joinJitsi() {
            const newWindow = window.open(roomUrl, '_blank');
            
            if (newWindow) {
                setTimeout(() => {
                    alert('🔑 كلمة المرور: ' + password + '\\n\\nأدخلها عند الطلب في صفحة Jitsi Meet');
                }, 2000);
            } else {
                alert('⚠️ يرجى السماح بفتح النوافذ المنبثقة');
            }
        }
    </script>
</body>
</html>
    `;
}

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// ✅ مسار بدء البث للأستاذ
// ============================================================

app.get('/api/teacher-start-stream/:offer_id/:teacher_id', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) {
            return res.status(401).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ يرجى تسجيل الدخول أولاً</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }
        
        const decoded = verifyToken(token);
        if (!decoded || decoded.role !== 'teacher') {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ غير مصرح لك</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const { offer_id, teacher_id } = req.params;
        if (decoded.userId !== parseInt(teacher_id)) {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ لا يمكنك بدء بث لهذا العرض</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer || offer.teacher_id !== parseInt(teacher_id)) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ العرض غير موجود</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        // جلب عدد الطلاب المسجلين
        const { count: studentsCount } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        // ✅ عرض صفحة بدء البث مع Jitsi
        res.send(generateTeacherStartPage(offer, teacher_id, token, studentsCount || 0));
        
    } catch (error) {
        console.error('❌ خطأ في بدء البث:', error.message);
        res.status(500).send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head><meta charset="UTF-8"><title>خطأ</title></head>
            <body style="font-family:Cairo;text-align:center;padding:50px;">
                <h1 style="color:#ef4444;">❌ حدث خطأ</h1>
                <p style="color:#64748b;">${escapeHtml(error.message)}</p>
                <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
            </body></html>
        `);
    }
});

// ============================================================
// ✅ مسار دخول الأستاذ للبث المباشر (Jitsi Meet فقط)
// ============================================================
app.get('/api/teacher-stream/:offer_id/:teacher_id', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) {
            return res.status(401).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ يرجى تسجيل الدخول أولاً</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }
        
        const decoded = verifyToken(token);
        if (!decoded || decoded.role !== 'teacher') {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ غير مصرح لك</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        const { offer_id, teacher_id } = req.params;
        if (decoded.userId !== parseInt(teacher_id)) {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ لا يمكنك الدخول إلى هذا البث</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        // ✅ جلب العرض للتأكد من وجوده
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#ef4444;">❌ العرض غير موجود</h1>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        // ✅ التحقق من حالة البث
        if (offer.status !== 'live' && offer.status !== 'teacher_ready') {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#f59e0b;">⏳ البث غير نشط حالياً</h1>
                    <p style="color:#94a3b8;">يرجى بدء البث أولاً من لوحة التحكم</p>
                    <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }

        // ✅ جلب كلمة المرور من العرض مباشرة
        const roomPassword = offer.room_password || null;

        // ✅ عرض صفحة الأستاذ للبث مع Jitsi
        res.send(generateTeacherStreamPage(offer, teacher_id, token, roomPassword));
        
    } catch (error) {
        console.error('❌ خطأ في دخول الأستاذ للبث:', error.message);
        res.status(500).send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head><meta charset="UTF-8"><title>خطأ</title></head>
            <body style="font-family:Cairo;text-align:center;padding:50px;">
                <h1 style="color:#ef4444;">❌ حدث خطأ</h1>
                <p style="color:#64748b;">${escapeHtml(error.message)}</p>
                <a href="/teacher-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
            </body></html>
        `);
    }
});

// ============================================================
// ✅ صفحة الأستاذ للبث المباشر (Jitsi Meet فقط)
// ============================================================

function generateTeacherStreamPage(offer, teacherId, token, roomPassword) {
    const offerId = offer.id;
    const subjectName = offer.subject_name || 'غير محدد';
    const roomUrl = offer.stream_url || `https://meet.jit.si/zoomdz_${offerId}`;
    const password = roomPassword || 'بدون كلمة مرور';
    
    return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>البث المباشر - Jitsi Meet</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Cairo', Arial, sans-serif; background: #0a0a1a; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { max-width: 650px; width: 90%; background: #1a1a2e; border-radius: 24px; padding: 40px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
        h1 { color: #0f5cbf; text-align: center; margin-bottom: 10px; font-size: 1.8rem; }
        .subtitle { text-align: center; color: #94a3b8; margin-bottom: 25px; }
        .info-box { background: #0f3460; border-radius: 12px; padding: 15px 20px; margin-bottom: 25px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
        .info-box span { color: #94a3b8; }
        .info-box strong { color: white; }
        .password-box { background: #0f3460; padding: 20px; border-radius: 12px; margin: 20px 0; border: 2px dashed rgba(96, 165, 250, 0.3); }
        .password-box span { color: #60a5fa; font-size: 1.8rem; font-weight: 900; letter-spacing: 6px; font-family: 'Courier New', monospace; }
        .password-label { color: #94a3b8; font-size: 0.8rem; margin-bottom: 8px; }
        .btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 16px 30px; border-radius: 12px; font-size: 1.1rem; font-weight: 700; cursor: pointer; width: 100%; transition: all 0.3s; margin-top: 20px; display: flex; align-items: center; justify-content: center; gap: 10px; }
        .btn:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(16, 185, 129, 0.4); }
        .btn-danger { background: linear-gradient(135deg, #ef4444, #dc2626); }
        .btn-danger:hover { box-shadow: 0 8px 25px rgba(239, 68, 68, 0.4); }
        .btn-back { background: transparent; color: #94a3b8; border: 1px solid #333; padding: 12px 24px; border-radius: 12px; cursor: pointer; transition: all 0.3s; margin-top: 10px; width: 100%; }
        .btn-back:hover { background: #1a1a2e; }
        .tip { background: #0f3460; border-radius: 12px; padding: 15px 20px; margin: 15px 0; border-right: 4px solid #f59e0b; }
        .tip h4 { color: #f59e0b; margin-bottom: 5px; }
        .tip p { color: #94a3b8; font-size: 0.9rem; line-height: 1.6; }
        .copy-btn { background: transparent; border: 1px solid #333; color: #94a3b8; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 0.8rem; transition: all 0.3s; margin-top: 8px; }
        .copy-btn:hover { background: #1a1a2e; border-color: #0f5cbf; color: white; }
        .status-badge { display: inline-block; padding: 4px 16px; border-radius: 20px; font-weight: 700; font-size: 0.8rem; }
        .status-live { background: #ef4444; color: white; animation: pulse 1.5s infinite; }
        .jitsi-badge { display: inline-block; background: #0f3460; padding: 4px 16px; border-radius: 20px; font-size: 0.7rem; color: #60a5fa; margin-bottom: 10px; border: 1px solid #0f5cbf; }
        @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.7; transform: scale(1.02); } }
        @media(max-width:600px) { .container { padding: 20px; } .info-box { flex-direction: column; } }
    </style>
</head>
<body>
<div class="container">
    <div class="jitsi-badge"><i class="fas fa-video"></i> Jitsi Meet</div>
    <h1>🎥 البث المباشر</h1>
    <p class="subtitle">كأستاذ - مجاني 100%</p>

    <div class="info-box">
        <div><span>📚 المادة:</span> <strong>${escapeHtml(subjectName)}</strong></div>
        <div><span>📊 الحالة:</span> <strong><span class="status-badge status-live">🔴 بث مباشر</span></strong></div>
    </div>

    <div class="password-box">
        <div class="password-label">🔑 كلمة مرور البث</div>
        <span id="roomPassword">${password}</span>
        <br>
        <button class="copy-btn" onclick="copyPassword()">
            <i class="fas fa-copy"></i> نسخ كلمة المرور
        </button>
    </div>

    <button class="btn" onclick="joinJitsi()">
        <i class="fas fa-video"></i> فتح البث المباشر (Jitsi Meet)
    </button>

    <button class="btn btn-danger" onclick="endStream()">
        <i class="fas fa-stop"></i> إنهاء البث
    </button>

    <button class="btn-back" onclick="window.location.href='/teacher-dashboard.html'">← العودة للوحة التحكم</button>

    <div class="tip">
        <h4>💡 نصائح للبث المباشر عبر Jitsi Meet</h4>
        <p>• تأكد من عمل الكاميرا والميكروفون<br>
        • شارك كلمة المرور فقط مع الطلاب المسجلين<br>
        • يمكنك مشاركة الشاشة لعرض المحتوى التعليمي<br>
        • اضغط على "إنهاء البث" عند الانتهاء<br>
        • ✅ مجاني 100% ولا يحتاج إلى تثبيت</p>
    </div>
</div>

<script>
    const roomUrl = '${roomUrl}';
    const password = '${password}';
    const offerId = ${parseInt(offerId)};
    const teacherId = ${parseInt(teacherId)};
    const authToken = '${token}';

    function copyPassword() {
        navigator.clipboard.writeText(password).then(() => {
            const btn = document.querySelector('.copy-btn');
            btn.innerHTML = '✅ تم النسخ';
            setTimeout(() => {
                btn.innerHTML = '<i class="fas fa-copy"></i> نسخ كلمة المرور';
            }, 2000);
        });
    }

    function joinJitsi() {
        const newWindow = window.open(roomUrl, '_blank');
        
        if (newWindow) {
            setTimeout(() => {
                alert('🔑 كلمة المرور: ' + password + '\\n\\nأدخلها عند الطلب في صفحة Jitsi Meet');
            }, 1500);
        } else {
            alert('⚠️ يرجى السماح بفتح النوافذ المنبثقة');
        }
    }

    function endStream() {
        if (confirm('⚠️ هل أنت متأكد من إنهاء البث المباشر؟')) {
            window.location.href = '/teacher-dashboard.html';
        }
    }
</script>
</body>
</html>`;
}

// ============================================================
// ✅ صفحة بدء البث للأستاذ (Jitsi Meet فقط)
// ============================================================

function generateTeacherStartPage(offer, teacherId, token, studentsCount) {
    const offerId = offer.id;
    const subjectName = offer.subject_name || 'غير محدد';
    
    return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>بدء البث المباشر - Jitsi Meet</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Cairo', Arial, sans-serif; background: #0a0a1a; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { max-width: 650px; width: 90%; background: #1a1a2e; border-radius: 24px; padding: 40px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
        h1 { color: #0f5cbf; text-align: center; margin-bottom: 10px; font-size: 1.8rem; }
        .subtitle { text-align: center; color: #94a3b8; margin-bottom: 25px; }
        .info-box { background: #0f3460; border-radius: 12px; padding: 15px 20px; margin-bottom: 25px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
        .info-box span { color: #94a3b8; }
        .info-box strong { color: white; }
        .btn-start { width: 100%; padding: 16px; background: linear-gradient(135deg, #0f5cbf, #0a4a9a); color: white; border: none; border-radius: 12px; font-size: 1.1rem; font-weight: 700; cursor: pointer; transition: all 0.3s; margin-top: 10px; }
        .btn-start:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(15, 92, 191, 0.4); }
        .btn-start:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-success { background: linear-gradient(135deg, #10b981, #059669); }
        .btn-success:hover { box-shadow: 0 8px 25px rgba(16, 185, 129, 0.4); }
        .btn-back { background: transparent; color: #94a3b8; border: 1px solid #333; padding: 12px 24px; border-radius: 12px; cursor: pointer; transition: all 0.3s; margin-top: 10px; width: 100%; }
        .btn-back:hover { background: #1a1a2e; }
        .tip { background: #0f3460; border-radius: 12px; padding: 15px 20px; margin: 15px 0; border-right: 4px solid #f59e0b; }
        .tip h4 { color: #f59e0b; margin-bottom: 5px; }
        .tip p { color: #94a3b8; font-size: 0.9rem; line-height: 1.6; }
        .success-box { background: rgba(16, 185, 129, 0.1); border: 1px solid #10b981; border-radius: 12px; padding: 15px 20px; margin: 15px 0; display: none; }
        .success-box h4 { color: #10b981; margin-bottom: 5px; }
        .success-box p { color: #94a3b8; font-size: 0.9rem; }
        .success-box .link-display { background: #0a0a1a; padding: 10px; border-radius: 8px; margin-top: 8px; word-break: break-all; color: #60a5fa; font-size: 0.85rem; border: 1px solid #1a1a2e; }
        .toast { position: fixed; bottom: 30px; right: 30px; left: 30px; background: #1a1a2e; color: white; padding: 16px 24px; border-radius: 12px; z-index: 2000; display: none; animation: slideIn 0.4s ease; box-shadow: 0 10px 40px rgba(0,0,0,0.5); font-size: 0.95rem; max-width: 440px; margin: 0 auto; border-right: 4px solid #10b981; }
        .toast.error { border-color: #ef4444; }
        .toast.warning { border-color: #f59e0b; }
        .jitsi-badge { display: inline-block; background: #0f3460; padding: 4px 16px; border-radius: 20px; font-size: 0.7rem; color: #60a5fa; margin-bottom: 10px; border: 1px solid #0f5cbf; }
        .status-badge { display: inline-block; padding: 4px 16px; border-radius: 20px; font-weight: 700; font-size: 0.8rem; }
        .status-live { background: #ef4444; color: white; animation: pulse 1.5s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.7; transform: scale(1.02); } }
        @keyframes slideIn { from { transform: translateY(100%) scale(0.95); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }
        @media(max-width:600px) {
            .container { padding: 20px; }
            .info-box { flex-direction: column; }
        }
    </style>
</head>
<body>
<div class="container">
    <div class="jitsi-badge"><i class="fas fa-video"></i> Jitsi Meet</div>
    <h1>🎥 بدء البث المباشر</h1>
    <p class="subtitle">مجاني 100% - لا يحتاج إلى تثبيت</p>

    <div class="info-box">
        <div><span>📚 المادة:</span> <strong>${escapeHtml(subjectName)}</strong></div>
        <div><span>👨‍🎓 الطلاب المسجلين:</span> <strong id="studentsCountDisplay">${studentsCount}</strong></div>
        <div><span>📊 الحالة:</span> <strong id="statusDisplay"><span class="status-badge" style="background:#64748b;">⏳ غير مفعل</span></strong></div>
    </div>

    <div class="tip">
        <h4>💡 ما هو Jitsi Meet؟</h4>
        <p>• <strong>بديل مجاني 100%</strong> لبرامج البث المباشر<br>
        • <strong>مجاني تماماً</strong> بدون أي حد زمني أو إعلانات<br>
        • <strong>آمن</strong> مع كلمة مرور للغرفة<br>
        • <strong>سريع</strong> ولا يحتاج إلى تثبيت أو حساب</p>
    </div>

    <button class="btn-start btn-success" id="startStreamBtn" onclick="startJitsiStream()">
        <i class="fas fa-play"></i> بدء البث المباشر (Jitsi Meet)
    </button>

    <button class="btn-start" id="addAllBtn" onclick="addAllStudents()" disabled>
        <i class="fas fa-users"></i> إضافة جميع الطلاب إلى البث
    </button>

    <button class="btn-back" onclick="window.location.href='/teacher-dashboard.html'">← العودة للوحة التحكم</button>

    <div class="success-box" id="successBox">
        <h4><i class="fas fa-check-circle"></i> تم بدء البث المباشر بنجاح!</h4>
        <p>رابط البث المحفوظ:</p>
        <div class="link-display" id="savedLinkDisplay"></div>
        <p style="margin-top: 8px; font-size: 0.8rem;">🟢 تم إرسال إشعارات للطلاب المسجلين</p>
        <p style="margin-top: 8px; font-size: 0.8rem; color: #f59e0b;">🔑 كلمة المرور: <strong id="passwordDisplay"></strong></p>
        <p style="margin-top: 8px; font-size: 0.7rem; color: #60a5fa;">✅ Jitsi Meet - مجاني 100%</p>
    </div>
</div>

<div class="toast" id="toast"></div>

<script>
    const authToken = '${token}';
    const offerId = ${parseInt(offerId)};
    const teacherId = ${parseInt(teacherId)};
    let csrfToken = '';
    let isStreamActive = false;

    const API_BASE_URL = window.location.hostname === 'localhost' 
        ? 'http://localhost:3000' 
        : window.location.origin;

    console.log('🌐 API Base URL:', API_BASE_URL);

    function showToast(message, type = 'success') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = 'toast';
        if (type === 'error') toast.classList.add('error');
        if (type === 'warning') toast.classList.add('warning');
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, 5000);
    }

    async function getCsrfToken() {
        try {
            const response = await fetch(API_BASE_URL + '/api/get-csrf-token', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + authToken },
                credentials: 'include'
            });
            const data = await response.json();
            csrfToken = data.csrfToken;
            return csrfToken;
        } catch (error) {
            console.error('خطأ في جلب CSRF Token:', error);
            return null;
        }
    }

    async function startJitsiStream() {
        const btn = document.getElementById('startStreamBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري بدء البث...';

        try {
            const response = await fetch(API_BASE_URL + '/api/start-jitsi-stream', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + authToken,
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({ offer_id: offerId })
            });

            const data = await response.json();

            if (data.success) {
                isStreamActive = true;
                document.getElementById('successBox').style.display = 'block';
                document.getElementById('savedLinkDisplay').textContent = data.room_url;
                document.getElementById('passwordDisplay').textContent = data.password;
                document.getElementById('statusDisplay').innerHTML = '<span class="status-badge status-live">🟢 بث مباشر</span>';
                document.getElementById('addAllBtn').disabled = false;
                
                showToast('✅ تم بدء البث عبر Jitsi Meet بنجاح!', 'success');
            } else {
                showToast('❌ ' + (data.error || 'حدث خطأ'), 'error');
            }
        } catch (error) {
            console.error('خطأ:', error);
            showToast('❌ حدث خطأ في الاتصال بالخادم', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-play"></i> بدء البث المباشر (Jitsi Meet)';
        }
    }

    async function addAllStudents() {
        if (!isStreamActive) {
            showToast('⚠️ الرجاء بدء البث أولاً', 'warning');
            return;
        }

        if (!confirm('⚠️ هل تريد إضافة جميع الطلاب إلى البث المباشر وإرسال الإشعارات؟')) return;

        const btn = document.getElementById('addAllBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الإضافة...';

        try {
            const response = await fetch(API_BASE_URL + '/api/stream/add-all-students/' + offerId, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + authToken,
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({
                    offer_id: offerId,
                    teacher_id: teacherId
                })
            });

            const data = await response.json();

            if (data.success) {
                showToast('✅ تم إضافة ' + (data.students_count || 0) + ' طالب وإرسال الإشعارات!', 'success');
            } else {
                showToast('❌ ' + (data.error || 'حدث خطأ'), 'error');
            }
        } catch (error) {
            console.error('خطأ:', error);
            showToast('❌ حدث خطأ في الاتصال بالخادم', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-users"></i> إضافة جميع الطلاب إلى البث';
        }
    }

    async function init() {
        await getCsrfToken();
        console.log('✅ تم تهيئة صفحة بدء البث مع Jitsi Meet');
    }

    init();
</script>
</body>
</html>`;
}

// ============================================================
// استيراد المسارات
// ============================================================

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const teacherRoutes = require('./routes/teacher');
const studentRoutes = require('./routes/student');
const offerRoutes = require('./routes/offer');
const publicRoutes = require('./routes/public');
const bookingRoutes = require('./routes/booking');
const streamRoutes = require('./routes/stream');
const postRoutes = require('./routes/post');
const messageRoutes = require('./routes/message');
const supportRoutes = require('./routes/support');
const referralRoutes = require('./routes/referral');
const walletRoutes = require('./routes/wallet');
const notificationRoutes = require('./routes/notification');

// ============================================================
// استخدام المسارات
// ============================================================

app.use('/api', publicRoutes);
app.use('/api', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/student', studentRoutes);
app.use('/api', offerRoutes);
app.use('/api/booking', bookingRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/post', postRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/notifications', notificationRoutes);

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
// مسار اختبار CORS
// ============================================================

app.get('/api/test-cors', (req, res) => {
    res.json({
        success: true,
        message: '✅ CORS يعمل بشكل صحيح',
        origin: req.headers.origin || 'no origin',
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// مسار Ping
// ============================================================

app.post('/api/ping', authenticate, async (req, res) => {
    try {
        const { offer_id, teacher_id } = req.body;
        
        if (offer_id && teacher_id) {
            await supabase
                .from('active_stream')
                .update({ 
                    last_ping: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('offer_id', offer_id)
                .eq('teacher_id', teacher_id);
        }
        
        res.json({ 
            success: true, 
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('❌ خطأ في ping:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// مسار التحقق من التوكن
// ============================================================

app.get('/api/verify-token', authenticate, (req, res) => {
    res.json({ 
        success: true, 
        valid: true,
        user: req.user,
        expiresIn: 24 * 60 * 60 * 1000
    });
});

// ============================================================
// مسار تجديد التوكن
// ============================================================

app.post('/api/refresh-token', authenticate, (req, res) => {
    try {
        const { userId, role, email } = req.user;
        const newToken = generateToken(userId, role, email);
        res.json({ 
            success: true, 
            token: newToken,
            expiresIn: 24 * 60 * 60 * 1000
        });
    } catch (error) {
        console.error('❌ خطأ في تجديد التوكن:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في تجديد الجلسة' });
    }
});

// ============================================================
// معالج الأخطاء
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
// تشغيل الخادم
// ============================================================

module.exports = app;

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
        console.log('=' .repeat(60));
        console.log('📅 التاريخ:', new Date().toLocaleString('ar-EG'));
        console.log('✅ نظام البث: Jitsi Meet (مجاني 100%)');
        console.log('=' .repeat(60));
    });
}
