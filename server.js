// ============================================================
// خادم منصة التعليم - الملف الرئيسي
// ============================================================

require('dotenv').config();

// الحزم الأساسية
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const xss = require('xss');

// استيراد وحدات التوجيه
const authRoutes = require('./routes/auth');
const teacherRoutes = require('./routes/teacher');
const studentRoutes = require('./routes/student');
const adminRoutes = require('./routes/admin');
const offerRoutes = require('./routes/offer');
const bookingRoutes = require('./routes/booking');
const streamRoutes = require('./routes/stream');
const referralRoutes = require('./routes/referral');
const messageRoutes = require('./routes/message');
const postRoutes = require('./routes/post');
const walletRoutes = require('./routes/wallet');
const supportRoutes = require('./routes/support');
const notificationRoutes = require('./routes/notification');

// ============================================================
// متغيرات البيئة والثوابت الأمنية
// ============================================================
const JWT_SECRET = process.env.JWT_SECRET || 'zoomdz_secret_key_2024_for_testing_only';
const JWT_EXPIRY = '24h';
const SALT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@platform.com';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || require('bcryptjs').hashSync('admin123', SALT_ROUNDS);
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'https://chatvidio.vercel.app';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ENCRYPTION_IV = process.env.ENCRYPTION_IV || crypto.randomBytes(16).toString('hex');

// تعريف التطبيق
const app = express();
const PORT = process.env.PORT || 3000;

// حل مشكلة X-Forwarded-For (لـ Vercel)
app.set('trust proxy', true);

// قراءة المتغيرات البيئية
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
const CHARGILY_API_KEY = process.env.CHARGILY_API_KEY;
const CHARGILY_API_URL = process.env.CHARGILY_API_URL || 'https://pay.chargily.net/api/v2';
const CHARGILY_WEBHOOK_SECRET = process.env.CHARGILY_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');

// قائمة المصادر المسموح بها لـ CORS
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

// تهيئة الاتصالات
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
// دوال قاعدة البيانات الأساسية
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
// دوال إرسال البريد
// ============================================================

async function sendVerificationEmail(toEmail, toName, verificationUrl) {
    try {
        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);
        const sanitizedUrl = sanitizeInput(verificationUrl);

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

        return true;
    } catch (error) {
        console.error('خطأ في إرسال البريد:', error.message);
        return false;
    }
}

// ============================================================
// دوال رفع الصور
// ============================================================
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

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
// دالة التحقق من reCAPTCHA v2
// ============================================================
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY;

async function verifyRecaptcha(token) {
    if (!RECAPTCHA_SECRET_KEY) {
        console.error('❌ مفتاح reCAPTCHA السري غير موجود');
        return { success: false, error: 'مفتاح reCAPTCHA غير مضبوط' };
    }

    if (!token) {
        return { success: false, error: 'رمز reCAPTCHA مطلوب' };
    }

    try {
        const axios = require('axios');
        const response = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            null,
            {
                params: {
                    secret: RECAPTCHA_SECRET_KEY,
                    response: token
                },
                timeout: 10000
            }
        );

        const data = response.data;

        if (data.success) {
            return { success: true };
        } else {
            console.error('❌ فشل التحقق من reCAPTCHA:', data['error-codes'] || 'خطأ غير معروف');
            return { 
                success: false, 
                error: 'فشل التحقق من أنك لست روبوتاً. يرجى المحاولة مرة أخرى.'
            };
        }
    } catch (error) {
        console.error('❌ خطأ في الاتصال بـ reCAPTCHA:', error.message);
        return { 
            success: false, 
            error: 'حدث خطأ في التحقق من reCAPTCHA. يرجى المحاولة مرة أخرى.'
        };
    }
}

// ============================================================
// نظام الإحالة - دوال إضافية
// ============================================================
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

        if (referral.referrer_role === 'teacher' && referredUserRole === 'teacher') {
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
                    description: `مكافأة إحالة أستاذ جديد - تم قبوله من الإدارة`,
                    created_at: new Date().toISOString()
                });

                console.log(`✅ تم إضافة 100 دج للمعلم ${teacher.full_name} فور قبول الأستاذ المحال`);
            }
        }

        if (referral.referrer_role === 'student') {
            console.log(`📌 الطالب المحيل سيحصل على فرصة صندوق هدايا عند حجز المحال درساً مدفوعاً`);
            
            await insert('referral_pending_rewards', {
                referral_id: referral.id,
                referrer_student_id: referral.referrer_id,
                referred_user_id: referredUserId,
                referred_user_role: referredUserRole,
                reward_type: 'gift_box_chance',
                status: 'pending_booking',
                created_at: new Date().toISOString()
            });
        }

        return true;
    } catch (error) {
        console.error('خطأ في معالجة مكافأة الإحالة:', error.message);
        return false;
    }
}

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

// ============================================================
// دالة معالجة مكافأة الطالب عند الحجز
// ============================================================
async function processStudentReferralRewardOnBooking(referredUserId, referredUserRole) {
    try {
        const { data: pendingRewards } = await supabase
            .from('referral_pending_rewards')
            .select('*')
            .eq('referred_user_id', referredUserId)
            .eq('referred_user_role', referredUserRole)
            .eq('status', 'pending_booking')
            .limit(1);

        if (!pendingRewards || pendingRewards.length === 0) {
            return false;
        }

        const pendingReward = pendingRewards[0];

        const student = await getOne('students', 'id', pendingReward.referrer_student_id);
        if (student) {
            const newChances = (student.gift_box_chances || 0) + 1;
            await supabase
                .from('students')
                .update({ 
                    gift_box_chances: newChances
                })
                .eq('id', pendingReward.referrer_student_id);

            await insert('referral_rewards', {
                student_id: pendingReward.referrer_student_id,
                referred_user_id: referredUserId,
                referred_user_role: referredUserRole,
                type: 'gift_box_chance',
                description: `فرصة صندوق هدايا - حجز المحال درساً مدفوعاً`,
                created_at: new Date().toISOString()
            });

            await supabase
                .from('referral_pending_rewards')
                .update({ 
                    status: 'completed',
                    completed_at: new Date().toISOString()
                })
                .eq('id', pendingReward.id);

            console.log(`✅ تم منح فرصة صندوق هدايا للطالب ${student.full_name} بعد حجز المحال درساً مدفوعاً`);
            return true;
        }

        return false;
    } catch (error) {
        console.error('خطأ في منح مكافأة الطالب:', error.message);
        return false;
    }
}

// ============================================================
// Middleware الأساسية والأمان
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

// التعامل مع طلبات OPTIONS
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

// Middleware التحقق من المصادقة
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
// إعدادات التطبيق
// ============================================================

app.use(compression());

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdnjs.cloudflare.com", "https://vercel.live", "https://*.vercel.app", "https://www.google.com", "https://www.gstatic.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://ui-avatars.com", "https://api.qrserver.com", "https://*.supabase.co", "https://www.google.com"],
            connectSrc: ["'self'", "https://*.supabase.co", "https://pay.chargily.net", "https://*.vercel.app", "https://www.google.com"],
            frameSrc: ["'self'", "https://meet.google.com", "https://www.google.com"]
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

app.use(cookieParser());

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

app.use('/api/login', authLimiter);
app.use('/api/forgot-password', authLimiter);
app.use('/api/resend-verification', authLimiter);

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

app.use((req, res, next) => {
    const publicPaths = [
        '/api/login',
        '/api/student/register',
        '/api/teacher/register',
        '/api/forgot-password',
        '/api/reset-password',
        '/api/verify-email',
        '/api/resend-verification',
        '/api/csrf-token',
        '/api/get-csrf-token',
        '/api/public/teachers',
        '/api/public/offers',
        '/api/public/stats',
        '/api/public/students-count',
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
        '/api/stream/add-student-to-stream',
        '/api/stream/end'
    ];
    
    const publicMethods = ['GET', 'HEAD', 'OPTIONS'];
    
    const isPublicPath = publicPaths.some(path => {
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
// مسارات عامة إضافية
// ============================================================
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
// تسجيل المسارات
// ============================================================
app.use('/api', authRoutes);
app.use('/api', teacherRoutes);
app.use('/api', studentRoutes);
app.use('/api', adminRoutes);
app.use('/api', offerRoutes);
app.use('/api', bookingRoutes);
app.use('/api', streamRoutes);
app.use('/api', referralRoutes);
app.use('/api', messageRoutes);
app.use('/api', postRoutes);
app.use('/api', walletRoutes);
app.use('/api', supportRoutes);
app.use('/api', notificationRoutes);

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
// تشغيل الخادم
// ============================================================

module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
        console.log('🔒 الأمان:');
        console.log('   ✅ Helmet مع CSP محسن');
        console.log('   ✅ JWT للمصادقة مع دعم Query Parameter');
        console.log('   ✅ CSRF Protection مع استثناء مسارات البث');
        console.log('   ✅ Rate Limiting متقدم');
        console.log('   ✅ تنقية جميع المدخلات (XSS)');
        console.log('   ✅ تشفير عناوين IP');
        console.log('   ✅ CORS مع Wildcard لـ Vercel');
        console.log('   ✅ reCAPTCHA v2 من Google');
        console.log('📧 نظام تأكيد البريد الإلكتروني مفعل');
        console.log('🔗 نظام الإحالة مفعل');
        console.log('🎁 صناديق الهدايا للطلاب مفعلة');
        console.log('='.repeat(60));
        console.log('🎥 نظام البث المباشر: Google Meet (مجاني 100%)');
        console.log('   ✅ لا يوجد حد زمني للبث');
        console.log('   ✅ 100 مشارك كحد أقصى (Google Meet مجاني)');
        console.log('   ✅ الأستاذ يمكنه إضافة الطلاب من قائمة الانتظار');
        console.log('   ✅ إضافة طالب واحد أو جميع الطلاب');
        console.log('   ✅ معالجة CSRF Token تلقائياً');
        console.log('='.repeat(60));
        console.log(`📅 التاريخ: ${new Date().toLocaleString('ar-EG')}`);
        console.log('='.repeat(60));
    });
}
