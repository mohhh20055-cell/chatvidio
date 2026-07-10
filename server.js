// ============================================================
// خادم منصة التعليم - الملف الرئيسي (معدل بالكامل)
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
const fs = require('fs');

// ✅ استيراد نظام السجلات
const logger = require('./utils/logger');

// ✅ استيراد الدوال المساعدة من ملفات منفصلة
const { generateToken, verifyToken } = require('./utils/jwt');
const { encrypt, maskIP } = require('./utils/encryption');

// ============================================================
// ✅ استيراد Middleware من الملف الخارجي
// ============================================================
const { authenticate, authorize, checkBanned, checkActiveStream, validateOfferOwnership, validateStudentAccess, checkStreamActive, checkNoActiveStream } = require('./middleware/auth');

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
    logger.error('متغيرات Supabase غير موجودة', {
        hasUrl: !!supabaseUrl,
        hasKey: !!supabaseKey
    });
    console.error('❌ خطأ: متغيرات Supabase غير موجودة');
    process.exit(1);
}

if (!resendApiKey) {
    logger.warn('متغير RESEND_API_KEY غير موجود - لن يتم إرسال البريد الإلكتروني', {
        env: process.env.NODE_ENV
    });
}

// تهيئة الاتصالات
const supabase = createClient(supabaseUrl, supabaseKey);
const resend = resendApiKey ? new Resend(resendApiKey) : null;

logger.info('تم تهيئة الاتصال بقاعدة البيانات', {
    supabaseUrl: supabaseUrl ? '(مخفي)' : 'غير موجود',
    hasResend: !!resend
});

// ✅ إنشاء ملف config.js العام لتكوين الواجهة الأمامية
const publicDir = path.join(__dirname, 'public');
const configJsPath = path.join(publicDir, 'config.js');
try {
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
    }
    fs.writeFileSync(configJsPath, `window.RECAPTCHA_SITE_KEY = ${JSON.stringify(recaptchaSiteKey || '')};\nwindow.API_BASE_URL = ${JSON.stringify(process.env.API_BASE_URL || '')};\n`);
    logger.info('تم إنشاء config.js');
} catch (e) {
    logger.error('فشل في كتابة config.js', { error: e.message });
}

// ============================================================
// دوال مساعدة عامة
// ============================================================

// ⚠️ دوال JWT متوفرة الآن في utils/jwt.js
// ⚠️ دوال التشفير متوفرة الآن في utils/encryption.js

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
        if (error && error.code !== 'PGRST116') {
            logger.error(`خطأ في getOne من جدول ${table}`, { 
                table, 
                column, 
                value,
                error: error.message 
            });
            return null;
        }
        return data;
    } catch (error) {
        logger.error(`استثناء في getOne من جدول ${table}`, { 
            table, 
            column, 
            error: error.message,
            stack: error.stack 
        });
        return null;
    }
}

async function insert(table, data) {
    try {
        const sanitizedData = sanitizeObject(data);
        const { data: result, error } = await supabase.from(table).insert(sanitizedData).select();
        if (error) {
            logger.error(`خطأ في insert إلى جدول ${table}`, { 
                table, 
                data: sanitizedData,
                error: error.message 
            });
            throw error;
        }
        logger.debug(`تم إدخال بيانات في جدول ${table}`, { table, insertedId: result?.[0]?.id });
        return result[0];
    } catch (error) {
        logger.error(`استثناء في insert إلى جدول ${table}`, { 
            table, 
            error: error.message,
            stack: error.stack 
        });
        throw error;
    }
}

async function update(table, id, data) {
    try {
        const sanitizedData = sanitizeObject(data);
        const { data: result, error } = await supabase.from(table).update(sanitizedData).eq('id', id).select();
        if (error) {
            logger.error(`خطأ في update لجدول ${table}`, { 
                table, 
                id, 
                data: sanitizedData,
                error: error.message 
            });
            throw error;
        }
        logger.debug(`تم تحديث بيانات في جدول ${table}`, { table, id });
        return result[0];
    } catch (error) {
        logger.error(`استثناء في update لجدول ${table}`, { 
            table, 
            id, 
            error: error.message,
            stack: error.stack 
        });
        throw error;
    }
}

async function remove(table, column, value) {
    try {
        const { error } = await supabase.from(table).delete().eq(column, value);
        if (error) {
            logger.error(`خطأ في remove من جدول ${table}`, { 
                table, 
                column, 
                value,
                error: error.message 
            });
            throw error;
        }
        return true;
    } catch (error) {
        logger.error(`استثناء في remove من جدول ${table}`, { 
            table, 
            column, 
            value,
            error: error.message,
            stack: error.stack 
        });
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
    '/api/student',
    '/api/student/stream-status',
    '/api/student/me',
    '/api/student/balance',
    '/api/student/notifications',
    '/api/student/sessions',
    '/api/teacher',
    '/api/teacher/me',
    '/api/teacher/balance',
    '/api/teacher/offers',
    '/api/teacher/students',
    '/api/booking',
    '/api/booking/create',
    '/api/booking/cancel',
    '/api/booking/stats',
    '/api/messages',
    '/api/messages/conversations',
    '/api/notifications',
    '/api/join-stream',
    '/api/teacher-start-stream',
    '/api/teacher-stream',
    '/api/referral',
    '/api/referral/create',
    '/api/referral/info',
    '/api/referral/open-gift-box',
    '/api/wallet',
    '/api/wallet/chargily-webhook',
    '/api/wallet/deposit',
    '/api/chargily-webhook',
    '/api/start-jitsi-stream',
    '/api/join-jitsi',
    '/api/stream/pause',
    '/api/stream/resume',
    '/api/stream/end',
    '/api/support/send',
    '/api/logs/stats',
    '/api/logs/errors',
    '/api/logs/all'
];

app.use((req, res, next) => {
    const publicMethods = ['GET', 'HEAD', 'OPTIONS'];
    
    // استخدام req.originalUrl بدلاً من req.path لأن req.path لا يحتوي على mount path
    const requestPath = req.originalUrl.split('?')[0]; // إزالة query string
    
    const isAdminPath = requestPath.startsWith('/api/admin');
    
    const isPublicPath = csrfExcludedPaths.some(path => {
        if (requestPath === path) return true;
        if (requestPath.startsWith(path + '/')) return true;
        return false;
    });
    
    const isPublicMethod = publicMethods.includes(req.method);
    
    if (isAdminPath || isPublicPath || isPublicMethod) {
        return next();
    }
    
    const csrfToken = req.headers['x-csrf-token'];
    const cookieToken = req.cookies.csrf_token;
    
    if (!csrfToken || !cookieToken || csrfToken !== cookieToken) {
        console.log(`❌ CSRF فشل: ${requestPath}`);
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
// API Logs (للوحة الأدمن logs.html)
// ============================================================

app.get('/api/logs/stats', authenticate, authorize(['admin']), (req, res) => {
    const stats = logger.getLogStats();
    res.json({ success: true, stats });
});

app.get('/api/logs/errors', authenticate, authorize(['admin']), (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const errors = logger.getRecentErrors(limit);
    res.json({ success: true, errors });
});

app.get('/api/logs/all', authenticate, authorize(['admin']), (req, res) => {
    const type = req.query.type || 'all';
    const limit = parseInt(req.query.limit) || 100;
    const logs = logger.getLogs(type, limit);
    res.json({ success: true, logs });
});

// ============================================================
// ✅ نظام البث المباشر باستخدام Jitsi Meet
// ============================================================

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
        
        const roomName = `zoomdz_${offer_id}_${Date.now()}`;
        const password = crypto.randomBytes(6).toString('hex').toUpperCase();
        const roomUrl = `https://meet.jit.si/${roomName}`;
        
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

// ============================================================
// ✅ استيراد المسارات
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
// ✅ استخدام المسارات - الترتيب مهم جداً!
// ============================================================

// ✅ 1. المسارات العامة (لا تحتاج مصادقة)
app.use('/api', publicRoutes);

// ✅ 2. مسارات المصادقة (تسجيل الدخول، تسجيل طالب، تسجيل أستاذ)
app.use('/api', authRoutes);

// ✅ 3. مسارات الإدارة (تحتاج مصادقة إدارية)
app.use('/api/admin', adminRoutes);

// ✅ 4. مسارات الأستاذ والطالب (تحتاج مصادقة)
app.use('/api/teacher', authenticate, teacherRoutes);
app.use('/api/student', authenticate, studentRoutes);

// ✅ 5. باقي المسارات
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

const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

// تطبيق معالج 404
app.use(notFoundHandler);

// تطبيق معالج الأخطاء العام
app.use(errorHandler);

// ============================================================
// مسارات السجلات والمراقبة (للأدمن)
// ============================================================

// جلب آخر الأخطاء
app.get('/api/logs/errors', authenticate, authorize(['admin']), (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const errors = logger.getRecentErrors(limit);
        
        res.json({
            success: true,
            errors: errors,
            count: errors.length
        });
    } catch (error) {
        logger.error('خطأ في جلب السجلات', { error: error.message });
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// جلب جميع السجلات
app.get('/api/logs/all', authenticate, authorize(['admin']), (req, res) => {
    try {
        const type = req.query.type || 'all';
        const limit = parseInt(req.query.limit) || 100;
        const logs = logger.getLogs(type, limit);
        
        res.json({
            success: true,
            logs: logs,
            type: type
        });
    } catch (error) {
        logger.error('خطأ في جلب السجلات', { error: error.message });
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// جلب إحصائيات السجلات
app.get('/api/logs/stats', authenticate, authorize(['admin']), (req, res) => {
    try {
        const stats = logger.getLogStats();
        
        res.json({
            success: true,
            stats: stats
        });
    } catch (error) {
        logger.error('خطأ في جلب إحصائيات السجلات', { error: error.message });
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// مسح سجلات الذاكرة
app.post('/api/logs/clear', authenticate, authorize(['admin']), (req, res) => {
    try {
        logger.clearMemory();
        
        logger.info('تم مسح سجلات الذاكرة من قبل الأدمن', {
            userId: req.user.userId
        });
        
        res.json({
            success: true,
            message: 'تم مسح السجلات بنجاح'
        });
    } catch (error) {
        logger.error('خطأ في مسح السجلات', { error: error.message });
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// جلب حالة الخادم
app.get('/api/health', (req, res) => {
    const memoryUsage = process.memoryUsage();
    
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: {
            heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memoryUsage.rss / 1024 / 1024)
        },
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || 'development'
    });
});

// ============================================================
// تشغيل الخادم
// ============================================================

module.exports = app;

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
        console.log('='.repeat(60));
        console.log('📅 التاريخ:', new Date().toLocaleString('ar-EG'));
        console.log('✅ نظام البث: Jitsi Meet (مجاني 100%)');
        console.log('✅ مسارات المصادقة: /api/student/register و /api/teacher/register');
        console.log('='.repeat(60));
    });
}
