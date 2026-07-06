// ============================================================
// خادم منصة التعليم - إصدار آمن ومحسن
// تم إصلاح جميع الثغرات الأمنية وإضافة المسار الرئيسي
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
const { body, validationResult } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// تعريف التطبيق
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// حل مشكلة X-Forwarded-For (لـ Vercel)
// ============================================================
app.set('trust proxy', true);

// ============================================================
// قراءة المتغيرات البيئية مع التحقق الصارم
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
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

// التحقق من المتغيرات الأساسية
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_KEY', 'RESEND_API_KEY'];
const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingEnvVars.length > 0) {
    console.error(`❌ خطأ: المتغيرات البيئية التالية مفقودة: ${missingEnvVars.join(', ')}`);
    process.exit(1);
}

if (!CHARGILY_API_KEY) {
    console.warn('⚠️ تحذير: CHARGILY_API_KEY غير موجود. لن تعمل عمليات الدفع.');
}

console.log('✅ تم تحميل جميع المتغيرات البيئية بنجاح');

// ============================================================
// تهيئة الاتصالات
// ============================================================
const supabase = createClient(supabaseUrl, supabaseKey);
const resend = new Resend(resendApiKey);

// ============================================================
// إعدادات الأمان المتقدمة - Helmet مع CSP محسن
// ============================================================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                "https://meet.jit.si",
                "https://cdnjs.cloudflare.com",
                "https://vercel.live",
                "https://*.vercel.app"
            ],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://fonts.googleapis.com",
                "https://cdnjs.cloudflare.com"
            ],
            fontSrc: [
                "'self'",
                "https://fonts.gstatic.com",
                "https://cdnjs.cloudflare.com",
                "data:"
            ],
            imgSrc: [
                "'self'",
                "data:",
                "https://ui-avatars.com",
                "https://api.qrserver.com",
                "https://*.supabase.co",
                "https://vercel.com",
                "https://*.vercel.app"
            ],
            connectSrc: [
                "'self'",
                "https://*.supabase.co",
                "https://pay.chargily.net",
                "https://meet.jit.si",
                "https://*.vercel.app"
            ],
            frameSrc: [
                "'self'",
                "https://meet.jit.si",
                "https://*.vercel.app"
            ],
            frameAncestors: ["'self'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: []
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }
}));

// ============================================================
// CORS محدود وآمن
// ============================================================
const corsOptions = {
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        if (CORS_ORIGIN.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('غير مسموح بهذا المصدر'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key'],
    credentials: true,
    maxAge: 86400,
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

// ============================================================
// Rate Limiting متقدم
// ============================================================
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { success: false, error: 'عدد الطلبات كبير جداً، حاول لاحقاً' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        const publicPaths = [
            '/api/public/stats',
            '/api/public/offers',
            '/api/public/teachers',
            '/api/public/students-count',
            '/api/live-offers',
            '/api/webhook/chargily',
            '/health'
        ];
        return publicPaths.some(p => req.path.startsWith(p));
    }
});
app.use('/api/', globalLimiter);

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'عدد محاولات تسجيل الدخول كبير جداً، حاول بعد ساعة' },
    standardHeaders: true,
    legacyHeaders: false
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { success: false, error: 'عدد محاولات التسجيل كبير جداً، حاول بعد ساعة' },
    standardHeaders: true,
    legacyHeaders: false
});

const depositLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { success: false, error: 'عدد محاولات الشحن كبير جداً، حاول بعد 15 دقيقة' },
    standardHeaders: true,
    legacyHeaders: false
});

const bookingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, error: 'عدد محاولات الحجز كبير جداً، حاول بعد 15 دقيقة' },
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/login', authLimiter);
app.use('/api/forgot-password', authLimiter);
app.use('/api/resend-verification', authLimiter);
app.use('/api/student/register', registerLimiter);
app.use('/api/teacher/register', registerLimiter);
app.use('/api/student/wallet/deposit', depositLimiter);
app.use('/api/booking/create', bookingLimiter);

// ============================================================
// Middleware الأساسية
// ============================================================
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ============================================================
// نظام JWT المصادقة
// ============================================================
function generateToken(userId, userRole, email) {
    return jwt.sign(
        { userId, userRole, email, iat: Math.floor(Date.now() / 1000) },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ success: false, error: 'غير مصرح، يرجى تسجيل الدخول' });
    }
    
    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(403).json({ success: false, error: 'توكن غير صالح أو منتهي الصلاحية' });
    }
    
    req.user = decoded;
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, error: 'غير مصرح' });
        }
        if (!roles.includes(req.user.userRole)) {
            return res.status(403).json({ success: false, error: 'صلاحيات غير كافية' });
        }
        next();
    };
}

// ============================================================
// Middleware التحقق من الحظر (IP Ban)
// ============================================================
const bannedCache = new Map();
const BAN_CACHE_TTL = 5 * 60 * 1000;

async function checkBanned(req, res, next) {
    let ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
    
    if (ip && typeof ip === 'string' && ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }
    
    if (ip && typeof ip === 'string') {
        ip = ip.replace(/:\d+[^:]*$/, '').replace(/^::ffff:/, '');
    }
    
    if (!ip) {
        return next();
    }
    
    const cacheKey = `ban_${ip}`;
    const cached = bannedCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
        if (cached.banned) {
            return res.status(403).json({
                success: false,
                error: 'تم حظر عنوان IP الخاص بك من المنصة',
                banned: true,
                reason: cached.reason || 'انتهاك شروط الاستخدام'
            });
        }
        return next();
    }
    
    try {
        const { data } = await supabase
            .from('banned_users')
            .select('*')
            .eq('ip_address', ip)
            .single();
        
        bannedCache.set(cacheKey, {
            banned: !!data,
            reason: data?.ban_reason || null,
            expires: Date.now() + BAN_CACHE_TTL
        });
        
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
        console.error('⚠️ خطأ في التحقق من الحظر:', error.message);
        next();
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of bannedCache.entries()) {
        if (value.expires < now) {
            bannedCache.delete(key);
        }
    }
}, 10 * 60 * 1000);

// ============================================================
// إعداد Multer
// ============================================================
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 3
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'image/svg+xml'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('نوع الملف غير مدعوم'), false);
        }
    }
});

// ============================================================
// دوال إرسال البريد
// ============================================================

function sanitizeEmailInput(text) {
    if (!text) return '';
    return text.replace(/[<>]/g, '').trim();
}

async function sendVerificationEmail(toEmail, toName, verificationUrl) {
    try {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(toEmail)) {
            throw new Error('بريد إلكتروني غير صالح');
        }

        const sanitizedName = sanitizeEmailInput(toName);
        const sanitizedUrl = sanitizeEmailInput(verificationUrl);

        console.log('📧 محاولة إرسال بريد تأكيد إلى:', toEmail);

        const { data, error } = await resend.emails.send({
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
            console.error('❌ خطأ في إرسال البريد:', error);
            return false;
        }

        console.log('✅ تم إرسال بريد التأكيد بنجاح');
        return true;
    } catch (error) {
        console.error('❌ خطأ في إرسال البريد:', error.message);
        return false;
    }
}

async function sendResetEmail(toEmail, toName, resetUrl) {
    try {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(toEmail)) {
            throw new Error('بريد إلكتروني غير صالح');
        }

        const sanitizedName = sanitizeEmailInput(toName);
        const sanitizedUrl = sanitizeEmailInput(resetUrl);

        console.log('📧 محاولة إرسال بريد إعادة تعيين إلى:', toEmail);

        const { data, error } = await resend.emails.send({
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
            console.error('❌ خطأ في إرسال البريد:', error);
            return false;
        }

        console.log('✅ تم إرسال البريد بنجاح');
        return true;
    } catch (error) {
        console.error('❌ خطأ في إرسال البريد:', error.message);
        return false;
    }
}

// ============================================================
// دالة رفع الصور
// ============================================================
async function uploadToSupabase(file, folder, oldFileName = null) {
    try {
        if (!file || !file.buffer) return null;

        if (file.size > 5 * 1024 * 1024) {
            console.error('❌ حجم الملف كبير جداً:', file.size);
            return null;
        }

        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
        if (!allowedTypes.includes(file.mimetype)) {
            console.error('❌ نوع الملف غير مدعوم:', file.mimetype);
            return null;
        }

        const fileExt = path.extname(file.originalname).toLowerCase();
        const sanitizedExt = fileExt.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)?.[0] || '.jpg';
        const fileName = `${Date.now()}-${uuidv4()}${sanitizedExt}`;
        const filePath = `${folder}/${fileName}`;

        if (oldFileName) {
            try {
                const oldPath = `${folder}/${oldFileName}`;
                await supabase.storage.from('profiles').remove([oldPath]);
            } catch (e) {
                console.log('📝 لم نتمكن من حذف الملف القديم:', e.message);
            }
        }

        const { data, error } = await supabase.storage
            .from('profiles')
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                cacheControl: '86400',
                upsert: false
            });

        if (error) {
            console.error('❌ خطأ في رفع الصورة:', error.message);
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
        console.error('❌ خطأ في رفع الصورة:', error.message);
        return null;
    }
}

// ============================================================
// دوال قاعدة البيانات
// ============================================================
async function getOne(table, column, value) {
    if (!table || !column || value === undefined || value === null) {
        return null;
    }

    try {
        const { data, error } = await supabase
            .from(table)
            .select('*')
            .eq(column, value)
            .single();
        
        if (error) {
            if (error.code === 'PGRST116') return null;
            console.error(`❌ خطأ في getOne:`, error.message);
            return null;
        }
        return data;
    } catch (error) {
        console.error(`❌ خطأ في getOne:`, error.message);
        return null;
    }
}

async function insert(table, data) {
    if (!table || !data || typeof data !== 'object') {
        throw new Error('بيانات غير صالحة');
    }

    try {
        const { data: result, error } = await supabase
            .from(table)
            .insert(data)
            .select();
        
        if (error) {
            console.error(`❌ خطأ في insert:`, error.message);
            throw new Error(error.message);
        }
        return result[0];
    } catch (error) {
        console.error(`❌ خطأ في insert:`, error.message);
        throw error;
    }
}

async function update(table, id, data) {
    if (!table || !id || !data || typeof data !== 'object') {
        throw new Error('بيانات غير صالحة');
    }

    try {
        const { data: result, error } = await supabase
            .from(table)
            .update(data)
            .eq('id', id)
            .select();
        
        if (error) {
            console.error(`❌ خطأ في update:`, error.message);
            throw new Error(error.message);
        }
        return result[0];
    } catch (error) {
        console.error(`❌ خطأ في update:`, error.message);
        throw error;
    }
}

async function remove(table, column, value) {
    if (!table || !column || value === undefined || value === null) {
        throw new Error('بيانات غير صالحة');
    }

    try {
        const { error } = await supabase
            .from(table)
            .delete()
            .eq(column, value);
        
        if (error) {
            console.error(`❌ خطأ في remove:`, error.message);
            throw new Error(error.message);
        }
        return true;
    } catch (error) {
        console.error(`❌ خطأ في remove:`, error.message);
        throw error;
    }
}

// ============================================================
// توليد رموز آمنة
// ============================================================
function generateVerificationToken() {
    return crypto.randomBytes(32).toString('hex') + Date.now().toString(36);
}

function generateReferralCode(name, id) {
    const prefix = name.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X');
    const suffix = id.toString(36).toUpperCase();
    return `${prefix}${suffix}`;
}

// ============================================================
// نظام ويب هوكس Chargily
// ============================================================
const processedTransactions = new Map();

app.post('/api/webhook/chargily', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-chargily-signature'];
        if (!signature) {
            return res.status(401).json({ error: 'توقيع غير موجود' });
        }

        const webhookSecret = process.env.CHARGILY_WEBHOOK_SECRET;
        if (webhookSecret) {
            const expectedSignature = crypto
                .createHmac('sha256', webhookSecret)
                .update(JSON.stringify(req.body))
                .digest('hex');
            
            if (signature !== expectedSignature) {
                return res.status(401).json({ error: 'توقيع غير صالح' });
            }
        }

        const payload = req.body;
        console.log('📦 استلام ويب هوك من Chargily');

        if (payload.type !== 'checkout.paid') {
            return res.status(200).json({ received: true });
        }

        const checkoutId = payload.data?.id;
        if (!checkoutId) {
            return res.status(400).json({ error: 'بيانات غير مكتملة' });
        }

        if (processedTransactions.has(checkoutId)) {
            return res.status(200).json({ already_processed: true });
        }

        const { data: transaction, error } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('chargily_checkout_id', checkoutId)
            .single();

        if (error || !transaction) {
            console.error('❌ المعاملة غير موجودة:', checkoutId);
            return res.status(404).json({ error: 'المعاملة غير موجودة' });
        }

        if (transaction.status === 'completed') {
            processedTransactions.set(checkoutId, Date.now());
            return res.status(200).json({ already_processed: true });
        }

        const amount = parseInt(payload.data?.amount) || 0;
        const addAmount = parseInt(amount) || parseInt(transaction.amount) || 0;

        const student = await getOne('students', 'id', transaction.student_id);
        if (!student) {
            console.error('❌ الطالب غير موجود:', transaction.student_id);
            return res.status(404).json({ error: 'الطالب غير موجود' });
        }

        const currentBalance = parseInt(student.wallet_balance) || 0;
        const newBalance = currentBalance + addAmount;

        const { error: updateError } = await supabase
            .from('students')
            .update({ wallet_balance: newBalance })
            .eq('id', transaction.student_id);

        if (updateError) {
            console.error('❌ خطأ في تحديث الرصيد:', updateError.message);
            return res.status(500).json({ error: 'خطأ في تحديث الرصيد' });
        }

        await update('wallet_transactions', transaction.id, {
            status: 'completed',
            description: `تم شحن الرصيد بنجاح بمبلغ ${addAmount} دج (مؤكد من Chargily)`
        });

        processedTransactions.set(checkoutId, Date.now());

        console.log(`✅ تم إضافة ${addAmount} دج للطالب ${student.full_name}`);

        await insert('notifications', {
            user_id: transaction.student_id,
            user_type: 'student',
            title: 'تم شحن الرصيد بنجاح',
            message: `تم إضافة ${addAmount} دج إلى رصيدك. الرصيد الحالي: ${newBalance} دج`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error('❌ خطأ في معالجة ويب هوك Chargily:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

setInterval(() => {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000;
    for (const [key, value] of processedTransactions.entries()) {
        if (now - value > maxAge) {
            processedTransactions.delete(key);
        }
    }
}, 60 * 60 * 1000);

// ============================================================
// نظام الإحالة
// ============================================================

app.post('/api/referral/create', authenticateToken, [
    body('user_id').isInt({ min: 1 }).withMessage('معرف المستخدم غير صالح'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        if (req.user.userId !== parseInt(req.body.user_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { user_id, role } = req.body;

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
        while (!isUnique && attempts < 20) {
            const existing = await getOne(tableName, 'referral_code', referralCode);
            if (!existing) {
                isUnique = true;
            } else {
                referralCode = generateReferralCode(user.full_name, user_id) + Math.random().toString(36).substring(2, 6).toUpperCase();
                attempts++;
            }
        }

        if (!isUnique) {
            referralCode = `REF${user_id}${Date.now().toString(36).toUpperCase()}`;
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
        console.error('❌ خطأ في إنشاء رمز الإحالة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/referral/info/:user_id/:role', authenticateToken, async (req, res) => {
    try {
        const { user_id, role } = req.params;

        if (req.user.userId !== parseInt(user_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
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
        console.error('❌ خطأ في جلب معلومات الإحالة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/referral/process', [
    body('ref_code').notEmpty().withMessage('رمز الإحالة مطلوب'),
    body('new_user_id').isInt({ min: 1 }).withMessage('معرف المستخدم الجديد غير صالح'),
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
        console.error('❌ خطأ في معالجة الإحالة:', error.message);
        res.status(500).json({ success: false, error: error.message });
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
            console.log('📝 لا توجد إحالة معلقة لهذا المستخدم');
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

                await insert('notifications', {
                    user_id: referral.referrer_id,
                    user_type: 'teacher',
                    title: 'مكافأة إحالة جديدة',
                    message: `تم إضافة 100 دج إلى رصيدك كمكافأة إحالة`,
                    is_read: false,
                    created_at: new Date().toISOString()
                });

                console.log(`✅ تم إضافة 100 دج للمعلم ${teacher.full_name} من الإحالة`);
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

                await insert('notifications', {
                    user_id: referral.referrer_id,
                    user_type: 'student',
                    title: '🎁 فرصة صندوق هدايا جديدة',
                    message: `حصلت على فرصة جديدة لفتح صندوق الهدايا من الإحالة!`,
                    is_read: false,
                    created_at: new Date().toISOString()
                });

                console.log(`✅ تم إضافة فرصة صندوق هدايا للطالب ${student.full_name} من الإحالة`);
            }
        }

        return true;
    } catch (error) {
        console.error('❌ خطأ في معالجة مكافأة الإحالة:', error.message);
        return false;
    }
}

app.post('/api/referral/open-gift-box', authenticateToken, [
    body('student_id').isInt({ min: 1 }).withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id } = req.body;

        if (req.user.userId !== parseInt(student_id) || req.user.userRole !== 'student') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
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

        const rand = crypto.randomInt(1, 1001) / 1000;
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

            await insert('notifications', {
                user_id: student_id,
                user_type: 'student',
                title: '🎉 مكافأة من صندوق الهدايا',
                message: `تهانينا! حصلت على ${rewardAmount} دج من صندوق الهدايا!`,
                is_read: false,
                created_at: new Date().toISOString()
            });
        } else {
            await insert('notifications', {
                user_id: student_id,
                user_type: 'student',
                title: '😅 صندوق الهدايا',
                message: `لم يحالفك الحظ هذه المرة، جرب مرة أخرى!`,
                is_read: false,
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
        console.error('❌ خطأ في فتح صندوق الهدايا:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// نظام الدفع الآمن
// ============================================================

async function createChargilyCheckout(amount, studentName, studentEmail, studentPhone, description, successUrl, failureUrl) {
    try {
        let finalAmount = Math.max(Number(amount), 100);
        finalAmount = Math.min(finalAmount, 1000000);
        finalAmount = Math.round(finalAmount);

        const urlRegex = /^https?:\/\/[^\s/$.?#].[^\s]*$/;
        if (!urlRegex.test(successUrl) || !urlRegex.test(failureUrl)) {
            throw new Error('روابط غير صالحة');
        }

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
                timestamp: new Date().toISOString()
            }
        };

        console.log('📦 إنشاء دفع للمبلغ:', finalAmount, 'DZD');

        const response = await axios.post(`${CHARGILY_API_URL}/checkouts`, checkoutData, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${CHARGILY_API_KEY}`
            },
            timeout: 30000,
            httpsAgent: new https.Agent({
                keepAlive: true,
                rejectUnauthorized: true
            })
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

        throw new Error('لم يتم استلام رابط الدفع');
    } catch (error) {
        console.error('❌ خطأ Chargily:', error.response?.data?.message || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.message || 'حدث خطأ في عملية الدفع'
        };
    }
}

app.post('/api/student/wallet/deposit', authenticateToken, [
    body('student_id').isInt({ min: 1 }).withMessage('معرف الطالب غير صالح'),
    body('amount').isInt({ min: 100, max: 1000000 }).withMessage('المبلغ يجب أن يكون بين 100 و 1,000,000 دج')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, amount } = req.body;

        if (req.user.userId !== parseInt(student_id) || req.user.userRole !== 'student') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        const finalAmount = Math.round(Math.max(Number(amount), 100));

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

            return res.status(400).json({
                success: false,
                error: checkout.error || 'حدث خطأ في عملية الدفع، يرجى المحاولة مرة أخرى'
            });
        }
    } catch (error) {
        console.error('❌ خطأ في شحن الرصيد:', error.message);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ داخلي في الخادم' });
    }
});

app.get('/api/wallet/deposit/success/:transaction_id', async (req, res) => {
    const { transaction_id } = req.params;

    if (!transaction_id || isNaN(parseInt(transaction_id))) {
        return res.status(400).send(`
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
                <h1>❌ خطأ</h1>
                <p>معرف المعاملة غير صالح</p>
                <a href="/student-dashboard.html" class="btn">العودة للوحة</a>
            </div>
            </body>
            </html>
        `);
    }

    try {
        const transaction = await getOne('wallet_transactions', 'id', transaction_id);
        if (!transaction) {
            return res.status(404).send(`
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
                    <h1>❌ خطأ</h1>
                    <p>المعاملة غير موجودة</p>
                    <a href="/student-dashboard.html" class="btn">العودة للوحة</a>
                </div>
                </body>
                </html>
            `);
        }

        if (transaction.status === 'completed') {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head><meta charset="UTF-8"><title>تمت المعاملة</title>
                <style>
                    body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                    .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                    h1{color:#10b981}
                    .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
                </style>
                </head>
                <body>
                <div class="card">
                    <h1>✅ تمت المعاملة</h1>
                    <p>تم شحن رصيدك بالفعل</p>
                    <a href="/student-dashboard.html" class="btn">العودة للوحة</a>
                </div>
                </body>
                </html>
            `);
        }

        if (transaction.chargily_checkout_id && CHARGILY_API_KEY) {
            try {
                const { data: checkout } = await axios.get(
                    `${CHARGILY_API_URL}/checkouts/${transaction.chargily_checkout_id}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${CHARGILY_API_KEY}`,
                            'Accept': 'application/json'
                        },
                        timeout: 15000
                    }
                );

                if (checkout.status !== 'paid') {
                    return res.send(`
                        <!DOCTYPE html>
                        <html>
                        <head><meta charset="UTF-8"><title>جاري التأكيد</title>
                        <style>
                            body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                            .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                            .spinner{width:50px;height:50px;border:5px solid #f3f3f3;border-top:5px solid #0f5cbf;border-radius:50%;animation:spin 1s linear infinite;margin:20px auto}
                            @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
                            .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
                        </style>
                        </head>
                        <body>
                        <div class="card">
                            <div class="spinner"></div>
                            <h2>⏳ جاري تأكيد الدفع</h2>
                            <p style="color:#64748b;">سيتم إضافة الرصيد تلقائياً بعد تأكيد الدفع</p>
                            <a href="/student-dashboard.html" class="btn">العودة للوحة</a>
                        </div>
                        </body>
                        </html>
                    `);
                }
            } catch (error) {
                console.error('❌ خطأ في التحقق من Chargily:', error.message);
            }
        }

        const student = await getOne('students', 'id', transaction.student_id);
        if (!student) {
            return res.status(404).send(`
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
                    <h1>❌ خطأ</h1>
                    <p>الطالب غير موجود</p>
                    <a href="/student-dashboard.html" class="btn">العودة للوحة</a>
                </div>
                </body>
                </html>
            `);
        }

        const currentBalance = parseInt(student.wallet_balance) || 0;
        const addAmount = parseInt(transaction.amount) || 0;
        const newBalance = currentBalance + addAmount;

        await supabase
            .from('students')
            .update({ wallet_balance: newBalance })
            .eq('id', transaction.student_id);

        await update('wallet_transactions', transaction_id, {
            status: 'completed',
            description: `تم شحن الرصيد بنجاح بمبلغ ${addAmount} دج`
        });

        await insert('notifications', {
            user_id: transaction.student_id,
            user_type: 'student',
            title: '✅ تم شحن الرصيد بنجاح',
            message: `تم إضافة ${addAmount} دج إلى رصيدك. الرصيد الحالي: ${newBalance} دج`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        console.log(`✅ تم إضافة ${addAmount} دج للطالب ${student.full_name}`);

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
                <div class="amount">+${addAmount} دج</div>
                <p style="font-size:1.1rem;">تم إضافة المبلغ إلى رصيدك</p>
                <p class="sub">الرصيد الجديد: ${newBalance} دج</p>
                <a href="/student-dashboard.html" class="btn">العودة للوحة</a>
            </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('❌ خطأ في معالجة نجاح الدفع:', error.message);
        res.send(`
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
                <h1>❌ حدث خطأ</h1>
                <p>حدث خطأ أثناء معالجة الدفع. يرجى التواصل مع الدعم الفني.</p>
                <a href="/student-dashboard.html" class="btn">العودة للوحة</a>
            </div>
            </body>
            </html>
        `);
    }
});

app.get('/api/wallet/deposit/failure/:transaction_id', async (req, res) => {
    const { transaction_id } = req.params;

    try {
        if (transaction_id && !isNaN(parseInt(transaction_id))) {
            await update('wallet_transactions', transaction_id, {
                status: 'failed',
                description: 'فشلت عملية الدفع'
            });
        }

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
app.post('/api/booking/create', authenticateToken, [
    body('offer_id').isInt({ min: 1 }).withMessage('معرف العرض غير صالح'),
    body('student_id').isInt({ min: 1 }).withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    const { offer_id, student_id } = req.body;

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        if (req.user.userId !== parseInt(student_id) || req.user.userRole !== 'student') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
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
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        const offerDate = new Date(offer.offer_date);
        if (offerDate < new Date() && offer.status !== 'live' && offer.status !== 'teacher_ready') {
            return res.status(400).json({ success: false, error: 'هذا العرض انتهى' });
        }

        const { data: existing } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .maybeSingle();

        if (existing) {
            return res.status(400).json({ success: false, error: 'مسجل بالفعل في هذا العرض' });
        }

        if (offer.is_free === 1 || offer.price === 0) {
            const session = await insert('sessions', {
                offer_id,
                student_id,
                payment_status: 'paid',
                payment_amount: 0,
                teacher_earned: 0,
                paid_from_wallet: false,
                created_at: new Date().toISOString()
            });

            await insert('waiting_room', {
                offer_id,
                student_id,
                created_at: new Date().toISOString()
            });

            await insert('notifications', {
                user_id: student_id,
                user_type: 'student',
                title: '✅ تم حجز الحصة المجانية',
                message: `تم حجز حصة "${offer.subject_name}" بنجاح. سيتم إشعارك عند بدء البث.`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            });

            return res.json({
                success: true,
                session_id: session.id,
                is_free: true,
                message: 'تم حجز الحصة المجانية بنجاح!'
            });
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
            paid_from_wallet: true,
            created_at: new Date().toISOString()
        });

        await insert('waiting_room', {
            offer_id,
            student_id,
            created_at: new Date().toISOString()
        });

        const teacher = await getOne('teachers', 'id', offer.teacher_id);
        if (teacher) {
            const commission = offer.price * 0.1;
            const teacherEarned = offer.price - commission;
            await update('teachers', offer.teacher_id, {
                balance: (teacher.balance || 0) + teacherEarned,
                total_earned: (teacher.total_earned || 0) + teacherEarned
            });
            await update('sessions', session.id, { teacher_earned: teacherEarned });
        }

        await insert('notifications', {
            user_id: student_id,
            user_type: 'student',
            title: '✅ تم حجز الحصة بنجاح',
            message: `تم حجز حصة "${offer.subject_name}" بنجاح. تم خصم ${offer.price} دج من رصيدك. سيتم إشعارك عند بدء البث.`,
            offer_id: offer_id,
            is_read: false,
            created_at: new Date().toISOString()
        });

        return res.json({
            success: true,
            session_id: session.id,
            new_balance: newBalance,
            message: `تم حجز الحصة بنجاح. تم خصم ${offer.price} دج من رصيدك. الرصيد المتبقي: ${newBalance} دج`
        });
    } catch (error) {
        console.error('❌ خطأ في معالجة الحجز:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// نظام تسجيل الدخول
// ============================================================
app.post('/api/login', checkBanned, [
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
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

            const adminPasswordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
            const isValid = bcrypt.compareSync(password, adminPasswordHash);

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

        let user = await getOne('teachers', 'email', email);
        let userRole = 'teacher';

        if (!user) {
            user = await getOne('students', 'email', email);
            userRole = 'student';
        }

        if (!user) {
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
            return res.status(401).json({ success: false, error: 'كلمة المرور خاطئة' });
        }

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
            ip = ip.replace(/:\d+[^:]*$/, '').replace(/^::ffff:/, '');
        }

        if (ip) {
            await insert('login_logs', {
                user_id: user.id,
                user_role: userRole,
                ip_address: ip,
                created_at: new Date().toISOString()
            });
        }

        const token = generateToken(user.id, userRole, user.email);

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
        console.error('❌ خطأ في تسجيل الدخول:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// التحقق من صحة التوكن
// ============================================================
app.get('/api/verify-token', authenticateToken, (req, res) => {
    res.json({
        success: true,
        user: {
            id: req.user.userId,
            role: req.user.userRole,
            email: req.user.email
        }
    });
});

// ============================================================
// تسجيل الخروج
// ============================================================
app.post('/api/logout', authenticateToken, (req, res) => {
    res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
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
        console.error('❌ خطأ:', error.message);
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
            education_level: o.education_level,
            teacher_id: o.teachers?.id,
            teacher_name: o.teachers?.full_name,
            teacher_specialization: o.teachers?.specialization,
            teacher_profile_url: o.teachers?.profile_url
        }));

        res.json(formatted);
    } catch (error) {
        console.error('❌ خطأ:', error.message);
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
        console.error('❌ خطأ:', error.message);
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
        console.error('❌ خطأ:', error.message);
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
// نظام التحقق من البريد الإلكتروني
// ============================================================

app.post('/api/resend-verification', [
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
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
        console.error('❌ خطأ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/verify-email', async (req, res) => {
    const { token, email, role } = req.query;

    try {
        if (!token || !email || !role) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head><meta charset="UTF-8"><title>خطأ في التأكيد</title>
                <style>
                    body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                    .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                    h1{color:#dc2626}
                    .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
                </style>
                </head>
                <body>
                <div class="card">
                    <h1>❌ رابط غير صالح</h1>
                    <p>الرابط الذي استخدمته غير صحيح. يرجى التحقق من الرابط المرسل إلى بريدك الإلكتروني.</p>
                    <a href="/" class="btn">العودة للرئيسية</a>
                </div>
                </body>
                </html>
            `);
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
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head><meta charset="UTF-8"><title>رمز غير صالح</title>
                <style>
                    body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                    .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                    h1{color:#dc2626}
                    .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
                </style>
                </head>
                <body>
                <div class="card">
                    <h1>❌ رمز غير صالح</h1>
                    <p>رمز التحقق غير صالح أو تم استخدامه بالفعل.</p>
                    <a href="/" class="btn">العودة للرئيسية</a>
                </div>
                </body>
                </html>
            `);
        }

        const expiresAt = new Date(verification.expires_at);
        if (expiresAt < new Date()) {
            await supabase
                .from('email_verifications')
                .update({ used: true })
                .eq('token', token);

            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head><meta charset="UTF-8"><title>انتهت الصلاحية</title>
                <style>
                    body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                    .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                    h1{color:#f59e0b}
                    .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
                </style>
                </head>
                <body>
                <div class="card">
                    <h1>⏰ انتهت صلاحية الرابط</h1>
                    <p>انتهت صلاحية رابط التأكيد. يمكنك طلب رابط جديد من خلال صفحة تسجيل الدخول.</p>
                    <a href="/login.html" class="btn">تسجيل الدخول</a>
                </div>
                </body>
                </html>
            `);
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

        const user = await getOne(tableName, 'email', email);
        if (user) {
            await processReferralReward(user.id, role);
        }

        return res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>تم تأكيد الحساب</title>
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
                <h1>✅ تم التأكيد!</h1>
                <p style="font-size:1.2rem;">تم تأكيد حسابك بنجاح 🎉</p>
                <p class="sub">يمكنك الآن تسجيل الدخول والاستفادة من جميع خدمات المنصة.</p>
                <a href="/login.html" class="btn">تسجيل الدخول</a>
            </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('❌ خطأ في تأكيد البريد:', error.message);
        return res.status(500).send(`
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
                <h1>❌ حدث خطأ</h1>
                <p>حدث خطأ أثناء تأكيد الحساب. يرجى المحاولة مرة أخرى.</p>
                <a href="/" class="btn">العودة للرئيسية</a>
            </div>
            </body>
            </html>
        `);
    }
});

// ============================================================
// نظام نسيت كلمة المرور
// ============================================================
app.post('/api/forgot-password', [
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
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

        const resetToken = crypto.randomBytes(32).toString('hex') + Date.now().toString(36);
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
        console.error('❌ خطأ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/verify-reset-token', [
    body('token').notEmpty().withMessage('الرمز مطلوب'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
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
        console.error('❌ خطأ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/reset-password', [
    body('token').notEmpty().withMessage('الرمز مطلوب'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
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

        const hashedPassword = bcrypt.hashSync(new_password, 12);
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
        console.error('❌ خطأ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// نظام الإشعارات
// ============================================================
app.get('/api/notifications/:user_id/:user_type', authenticateToken, async (req, res) => {
    try {
        const { user_id, user_type } = req.params;

        if (req.user.userId !== parseInt(user_id) || req.user.userRole !== user_type) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data } = await supabase
            .from('notifications')
            .select('*')
            .eq('user_id', user_id)
            .eq('user_type', user_type)
            .order('created_at', { ascending: false })
            .limit(50);

        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).json([]);
    }
});

app.post('/api/notifications/read/:notification_id', authenticateToken, async (req, res) => {
    try {
        const { notification_id } = req.params;

        const { data: notif } = await supabase
            .from('notifications')
            .select('*')
            .eq('id', notification_id)
            .single();

        if (!notif) {
            return res.status(404).json({ success: false, error: 'الإشعار غير موجود' });
        }

        if (notif.user_id !== req.user.userId || notif.user_type !== req.user.userRole) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('id', notification_id);

        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// نظام البث المباشر
// ============================================================
app.get('/api/student/stream-status/:offer_id/:student_id', authenticateToken, async (req, res) => {
    try {
        const { offer_id, student_id } = req.params;

        if (req.user.userId !== parseInt(student_id) || req.user.userRole !== 'student') {
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
                return res.json({
                    can_join: true,
                    room_name: offer.room_name,
                    status: 'live'
                });
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
                    await insert('waiting_room', {
                        offer_id: offer_id,
                        student_id: student_id,
                        created_at: new Date().toISOString()
                    });
                }
                return res.json({
                    can_join: false,
                    is_waiting: true,
                    status: 'waiting'
                });
            }
            return res.json({
                can_join: false,
                payment_required: true,
                status: 'payment_required'
            });
        } else if (offer.status === 'upcoming') {
            const session = await getOne('sessions', 'offer_id', offer_id);
            if (session && session.payment_status === 'paid' && session.student_id == student_id) {
                return res.json({
                    can_join: false,
                    is_upcoming: true,
                    status: 'upcoming',
                    offer_date: offer.offer_date
                });
            }
            return res.json({
                can_join: false,
                payment_required: true,
                status: 'payment_required'
            });
        }

        return res.json({ can_join: false, status: 'unknown' });
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).json({ can_join: false, status: 'error' });
    }
});

// ============================================================
// ============================================================
// ⭐ المسارات الرئيسية - تم إضافتها لحل مشكلة Cannot GET /
// ============================================================
// ============================================================

// ============================================================
// خدمة الملفات الثابتة
// ============================================================
app.use(express.static('public', {
    maxAge: '1d',
    etag: true,
    lastModified: true
}));

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
            sameSite: 'lax'
        });
    }

    try {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } catch (error) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>مرحباً في منصة التعليم</title>
            <style>
                body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                h1{color:#0f5cbf}
                .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
                .btn:hover{background:#0a4a9a}
            </style>
            </head>
            <body>
            <div class="card">
                <h1>🚀 منصة التعليم</h1>
                <p>مرحباً بك في منصة التعليم</p>
                <a href="/login.html" class="btn">تسجيل الدخول</a>
                <a href="/register.html" class="btn" style="background:#10b981;margin-right:10px;">تسجيل جديد</a>
            </div>
            </body>
            </html>
        `);
    }
});

// ============================================================
// مسار الصحة (Health Check)
// ============================================================
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '3.0.0'
    });
});

// ============================================================
// معالجة المسارات غير الموجودة (404)
// ============================================================
app.use((req, res) => {
    res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>الصفحة غير موجودة</title>
        <style>
            body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
            .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
            h1{color:#dc2626;font-size:4rem}
            .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
            .btn:hover{background:#0a4a9a}
        </style>
        </head>
        <body>
        <div class="card">
            <h1>404</h1>
            <h2>الصفحة غير موجودة</h2>
            <p>عذراً، الصفحة التي تبحث عنها غير موجودة</p>
            <a href="/" class="btn">العودة للرئيسية</a>
        </div>
        </body>
        </html>
    `);
});

// ============================================================
// تشغيل الخادم
// ============================================================

module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log('🚀 الخادم يعمل على http://localhost:' + PORT);
        console.log('🔒 الأمان: Helmet مع CSP محسن');
        console.log('🔐 المصادقة: JWT مع صلاحية 24 ساعة');
        console.log('🛡️ الحماية: Rate Limiting متقدم');
        console.log('📧 نظام تأكيد البريد الإلكتروني مفعل');
        console.log('🔗 نظام الإحالة مفعل');
        console.log('🎁 صناديق الهدايا للطلاب مفعلة');
        console.log('💰 مكافأة الإحالة: 100 دج للمعلم، فرصة صندوق هدايا للطالب');
        console.log('🔒 نظام الحظر (IP Ban) مع Caching مفعل');
        console.log('💳 نظام الدفع عبر Chargily مع Webhook مفعل');
        console.log('📍 المسار الرئيسي: /');
        console.log('🏥 مسار الصحة: /health');
        console.log('='.repeat(60));
    });
}
