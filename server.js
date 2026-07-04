// ============================================================
// خادم منصة التعليم - إصدار آمن ومحسن
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
const { body, validationResult } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

// تعريف التطبيق
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// قراءة المتغيرات البيئية
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
const CHARGILY_API_KEY = process.env.CHARGILY_API_KEY;
const CHARGILY_API_URL = process.env.CHARGILY_API_URL || 'https://pay.chargily.net/test/api/v2';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@platform.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CORS_ORIGIN = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['https://your-app.vercel.app', 'http://localhost:3000'];

// التحقق من المتغيرات الأساسية
if (!supabaseUrl || !supabaseKey) {
    console.error('خطأ: متغيرات Supabase غير موجودة');
    process.exit(1);
}

if (!resendApiKey) {
    console.error('خطأ: متغير RESEND_API_KEY غير موجود');
    process.exit(1);
}

if (!CHARGILY_API_KEY) {
    console.warn('تحذير: CHARGILY_API_KEY غير موجود، استخدم المفتاح التجريبي');
}

console.log('الاتصال بـ Supabase:', supabaseUrl);

// ============================================================
// تهيئة الاتصالات
// ============================================================
const supabase = createClient(supabaseUrl, supabaseKey);
const resend = new Resend(resendApiKey);

// ============================================================
// إعدادات الأمان
// ============================================================

// 1. Helmet - حماية من هجمات XSS
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://meet.jit.si", "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://ui-avatars.com", "https://api.qrserver.com", "https://*.supabase.co"],
            connectSrc: ["'self'", "https://*.supabase.co", "https://pay.chargily.net", "https://meet.jit.si"],
            frameSrc: ["'self'", "https://meet.jit.si"]
        }
    }
}));

// 2. CORS محدود
const corsOptions = {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
    maxAge: 86400
};
app.use(cors(corsOptions));

// 3. Rate Limiting - منع هجمات DDoS
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, error: 'عدد الطلبات كبير جداً، حاول لاحقاً' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        return req.path.startsWith('/api/stream') ||
               req.path.startsWith('/api/public/stats') ||
               req.path.startsWith('/api/public/offers') ||
               req.path.startsWith('/api/join-stream');
    }
});
app.use('/api/', limiter);

// 4. زيادة حد الطلبات لمسارات معينة
const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'عدد محاولات تسجيل الدخول كبير جداً، حاول بعد ساعة' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/login', authLimiter);
app.use('/api/forgot-password', authLimiter);

// ============================================================
// Middleware الأساسية
// ============================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public', {
    maxAge: '1d',
    etag: true,
    lastModified: true
}));

// ============================================================
// إعداد Multer
// ============================================================
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 5
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('نوع الملف غير مدعوم'), false);
        }
    }
});

// ============================================================
// دالة إرسال البريد
// ============================================================
async function sendResetEmail(toEmail, toName, resetUrl) {
    try {
        console.log('محاولة إرسال بريد إلى:', toEmail);

        const { data, error } = await resend.emails.send({
            from: 'منصة التعليم <onboarding@resend.dev>',
            to: [toEmail],
            subject: 'إعادة تعيين كلمة المرور - منصة التعليم',
            html: `
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"></head>
                <body style="font-family:'Cairo',Arial,sans-serif;text-align:center;padding:20px;">
                    <div style="max-width:500px;margin:auto;background:#f8f9fa;border-radius:20px;padding:30px;">
                        <h2 style="color:#0f5cbf;">منصة التعليم</h2>
                        <div style="font-size:3rem;">🔐</div>
                        <p style="font-size:1.1rem;color:#333;">لقد طلبت إعادة تعيين كلمة المرور الخاصة بك.</p>
                        <a href="${resetUrl}" style="background:#0f5cbf;color:white;padding:12px 25px;text-decoration:none;border-radius:30px;display:inline-block;margin:20px 0;">إعادة تعيين كلمة المرور</a>
                        <p style="color:#666;font-size:0.8rem;">هذا الرابط صالح لمدة ساعة واحدة.</p>
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

        const fileExt = path.extname(file.originalname);
        const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${fileExt}`;
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
// Chargily API
// ============================================================
async function createChargilyCheckout(amount, studentName, studentEmail, studentPhone, description, successUrl, failureUrl) {
    try {
        let finalAmount = Math.max(amount, 50);

        const checkoutData = {
            amount: finalAmount,
            currency: 'dzd',
            success_url: successUrl,
            failure_url: failureUrl,
            locale: 'ar',
            description: description,
            metadata: {
                student_name: studentName,
                student_email: studentEmail,
                type: 'wallet_deposit'
            }
        };

        console.log('إنشاء دفع للمبلغ:', finalAmount, 'DZD');

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
                    console.log('تم إنشاء رابط الدفع');
                    return {
                        success: true,
                        checkout_url: response.data.checkout_url,
                        checkout_id: response.data.id
                    };
                }
            } catch (error) {
                lastError = error;
                console.log(`محاولة ${i + 1} فشلت`);
                if (i < authMethods.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        throw new Error(lastError?.response?.data?.message || lastError?.message || 'فشلت جميع محاولات الدفع');
    } catch (error) {
        console.error('خطأ Chargily:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.message
        };
    }
}

// ============================================================
// دوال قاعدة البيانات
// ============================================================
async function getOne(table, column, value) {
    const { data, error } = await supabase
        .from(table)
        .select('*')
        .eq(column, value)
        .single();
    if (error && error.code !== 'PGRST116') return null;
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

// ============================================================
// المسار الرئيسي
// ============================================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// المسارات العامة (مع تحسين الأمان)
// ============================================================
app.get('/api/public/teachers', async (req, res) => {
    try {
        const { data } = await supabase
            .from('teachers')
            .select('id, full_name, specialization, bio, experience, profile_url')
            .eq('status', 'approved')
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
            supabase.from('teachers').select('*', { count: 'exact', head: true }).eq('status', 'approved'),
            supabase.from('offers').select('*', { count: 'exact', head: true })
                .eq('status', 'upcoming')
                .gt('offer_date', new Date().toISOString()),
            supabase.from('offers').select('*', { count: 'exact', head: true }).eq('status', 'live'),
            supabase.from('students').select('*', { count: 'exact', head: true })
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
            .select('*', { count: 'exact', head: true });
        res.json({ count: count || 0 });
    } catch (error) {
        res.status(500).json({ count: 0 });
    }
});

// ============================================================
// نظام المنشورات
// ============================================================
app.post('/api/post/create', upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('title').notEmpty().withMessage('العنوان مطلوب'),
    body('content').notEmpty().withMessage('المحتوى مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, title, content, link_url } = req.body;
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
        res.status(500).json({ success: false, error: error.message });
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
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/post/like', [
    body('post_id').isInt().withMessage('معرف المنشور غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { post_id, student_id } = req.body;
        await insert('post_likes', { post_id, student_id });

        const { count } = await supabase
            .from('post_likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        await update('posts', post_id, { likes: count });
        res.json({ success: true, liked: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/post/unlike', [
    body('post_id').isInt().withMessage('معرف المنشور غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { post_id, student_id } = req.body;
        await supabase.from('post_likes').delete().eq('post_id', post_id).eq('student_id', student_id);

        const { count } = await supabase
            .from('post_likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        await update('posts', post_id, { likes: count });
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
            .eq('post_id', req.params.post_id)
            .eq('student_id', req.params.student_id)
            .single();
        res.json({ liked: !!data });
    } catch (error) {
        res.json({ liked: false });
    }
});

app.post('/api/post/comment', [
    body('post_id').isInt().withMessage('معرف المنشور غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح'),
    body('comment').notEmpty().withMessage('التعليق مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { post_id, student_id, comment } = req.body;

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
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/post/comment/:comment_id', [
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

        const post = await getOne('posts', 'id', post_id);
        if (!post || post.teacher_id != teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        await remove('post_comments', 'id', comment_id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/post/:post_id', [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { post_id } = req.params;
        const { teacher_id } = req.body;

        const post = await getOne('posts', 'id', post_id);
        if (!post || post.teacher_id != teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        await supabase.from('post_likes').delete().eq('post_id', post_id);
        await supabase.from('post_comments').delete().eq('post_id', post_id);
        await remove('posts', 'id', post_id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// نظام رسائل الدعم
// ============================================================
app.post('/api/support/send', [
    body('name').notEmpty().withMessage('الاسم مطلوب'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
    body('subject').notEmpty().withMessage('الموضوع مطلوب'),
    body('message').notEmpty().withMessage('الرسالة مطلوبة')
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

        console.log(`رسالة دعم جديدة من ${name} (${email})`);
        res.json({ success: true, message: 'تم إرسال رسالتك بنجاح' });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/support-messages', async (req, res) => {
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

app.put('/api/admin/support-messages/:id/read', async (req, res) => {
    try {
        await update('support_messages', req.params.id, { status: 'read' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/admin/support-messages/:id', async (req, res) => {
    try {
        await remove('support_messages', 'id', req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// نظام الرصيد (Wallet)
// ============================================================
app.get('/api/student/wallet/:student_id', async (req, res) => {
    try {
        const student = await getOne('students', 'id', req.params.student_id);
        if (!student) return res.status(404).json({ error: 'طالب غير موجود' });

        const { data: transactions } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('student_id', req.params.student_id)
            .order('created_at', { ascending: false })
            .limit(20);

        res.json({
            balance: student.wallet_balance || 0,
            transactions: transactions || []
        });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ error: error.message, transactions: [] });
    }
});

app.post('/api/student/wallet/deposit', [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح'),
    body('amount').isInt({ min: 100 }).withMessage('المبلغ يجب أن لا يقل عن 100 دج')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, amount } = req.body;

        const student = await getOne('students', 'id', student_id);
        if (!student) return res.status(404).json({ success: false, error: 'طالب غير موجود' });

        const transaction = await insert('wallet_transactions', {
            student_id: student_id,
            amount: amount,
            type: 'deposit',
            status: 'pending',
            description: `محاولة شحن رصيد بقيمة ${amount} دج`,
            created_at: new Date().toISOString()
        });

        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const successUrl = `${baseUrl}/api/wallet/deposit/success/${transaction.id}`;
        const failureUrl = `${baseUrl}/api/wallet/deposit/failure/${transaction.id}`;

        const checkout = await createChargilyCheckout(
            amount,
            student.full_name,
            student.email,
            student.phone,
            `شحن رصيد منصة التعليم - ${amount} دج`,
            successUrl,
            failureUrl
        );

        if (checkout.success && checkout.checkout_url) {
            await update('wallet_transactions', transaction.id, { chargily_checkout_id: checkout.checkout_id });
            return res.json({
                success: true,
                checkout_url: checkout.checkout_url,
                transaction_id: transaction.id
            });
        } else {
            await update('wallet_transactions', transaction.id, {
                status: 'failed',
                description: `فشل الشحن: ${checkout.error}`
            });
            return res.status(400).json({ success: false, error: checkout.error });
        }
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/wallet/deposit/success/:transaction_id', async (req, res) => {
    const { transaction_id } = req.params;

    try {
        const transaction = await getOne('wallet_transactions', 'id', transaction_id);
        if (!transaction) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head><meta charset="UTF-8"><title>خطأ</title>
                <style>body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:white;padding:40px;border-radius:20px;text-align:center}</style>
                </head>
                <body><div class="card"><h1>❌ خطأ</h1><p>المعاملة غير موجودة</p><a href="/student-dashboard.html">العودة</a></div></body>
                </html>
            `);
        }

        if (transaction.status === 'pending') {
            await update('wallet_transactions', transaction_id, {
                status: 'completed',
                description: `تم شحن الرصيد بنجاح بمبلغ ${transaction.amount} دج`
            });

            const student = await getOne('students', 'id', transaction.student_id);
            const newBalance = (student.wallet_balance || 0) + transaction.amount;
            await update('students', transaction.student_id, { wallet_balance: newBalance });
        }

        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>تم شحن الرصيد</title>
            <style>body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:white;padding:40px;border-radius:20px;text-align:center}.btn{background:#10b981;color:white;padding:12px 25px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}</style>
            </head>
            <body>
            <div class="card"><h1>✅ تم شحن الرصيد بنجاح!</h1><p>تم إضافة ${transaction?.amount || 0} دج إلى رصيدك</p><a href="/student-dashboard.html" class="btn">العودة للوحة</a></div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('خطأ:', error.message);
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>خطأ</title>
            <style>body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:white;padding:40px;border-radius:20px;text-align:center}</style>
            </head>
            <body><div class="card"><h1>❌ حدث خطأ</h1><p>${error.message}</p><a href="/student-dashboard.html">العودة</a></div></body>
            </html>
        `);
    }
});

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
            <style>body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:white;padding:40px;border-radius:20px;text-align:center}.btn{background:#0f5cbf;color:white;padding:12px 25px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}</style>
            </head>
            <body>
            <div class="card"><h1>❌ فشل شحن الرصيد!</h1><p>حدث خطأ أثناء عملية الشحن</p><a href="/student-dashboard.html" class="btn">المحاولة مرة أخرى</a></div>
            </body>
            </html>
        `);
    } catch (error) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>خطأ</title>
            <style>body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:white;padding:40px;border-radius:20px;text-align:center}</style>
            </head>
            <body><div class="card"><h1>❌ حدث خطأ</h1><a href="/student-dashboard.html">العودة</a></div></body>
            </html>
        `);
    }
});

// ============================================================
// نظام الحجز
// ============================================================
app.post('/api/booking/create', [
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    const { offer_id, student_id } = req.body;

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
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

        const student = await getOne('students', 'id', student_id);
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
        return res.status(500).json({ success: false, error: error.message });
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

        const resetToken = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
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
        const resetUrl = `${baseUrl}/reset-password.html?token=${resetToken}&email=${email}&role=${role}`;

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
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/reset-password', [
    body('token').notEmpty().withMessage('الرمز مطلوب'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح'),
    body('new_password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل')
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

        const hashedPassword = bcrypt.hashSync(new_password, 10);
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// نظام المراسلات
// ============================================================
app.post('/api/messages/send', [
    body('sender_id').isInt().withMessage('معرف المرسل غير صالح'),
    body('sender_type').isIn(['student', 'teacher']).withMessage('نوع المرسل غير صالح'),
    body('receiver_id').isInt().withMessage('معرف المستقبل غير صالح'),
    body('receiver_type').isIn(['student', 'teacher']).withMessage('نوع المستقبل غير صالح'),
    body('message').notEmpty().withMessage('الرسالة مطلوبة')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { sender_id, sender_type, receiver_id, receiver_type, message } = req.body;

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
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/messages/conversations/:user_id/:user_type', async (req, res) => {
    try {
        const { user_id, user_type } = req.params;

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

app.get('/api/messages/:user_id/:user_type/:other_id/:other_type', async (req, res) => {
    try {
        const { user_id, user_type, other_id, other_type } = req.params;

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
app.post('/api/teacher/register', upload.fields([
    { name: 'profile_image', maxCount: 1 },
    { name: 'diploma_image', maxCount: 1 },
    { name: 'id_image', maxCount: 1 }
]), [
    body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
    body('password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
    body('phone').notEmpty().withMessage('رقم الهاتف مطلوب'),
    body('specialization').notEmpty().withMessage('التخصص مطلوب'),
    body('bio').notEmpty().withMessage('نبذة عنك مطلوبة'),
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

        const hashedPassword = bcrypt.hashSync(password, 10);
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

        await insert('teachers', {
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
            balance: 0,
            total_earned: 0,
            total_withdrawn: 0,
            pending_withdraw: 0
        });

        res.json({ success: true, message: 'تم إرسال طلبك، سيتم مراجعته من قبل الإدارة' });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// تسجيل طالب
app.post('/api/student/register', [
    body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب'),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
    body('password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
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

        const hashedPassword = bcrypt.hashSync(password, 10);
        await insert('students', {
            full_name: full_name.trim(),
            email: email.trim(),
            password: hashedPassword,
            phone: phone.trim(),
            wallet_balance: 0
        });

        res.json({ success: true, message: 'تم التسجيل بنجاح' });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// تحديث بيانات الطالب
app.post('/api/student/update-profile', upload.single('profile_image'), [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, full_name, phone } = req.body;
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
            .eq('id', parseInt(student_id))
            .select();

        if (error) throw error;

        res.json({ success: true, message: 'تم تحديث الملف الشخصي', user: data[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// جلب بيانات طالب
app.get('/api/student/:student_id', async (req, res) => {
    try {
        const student = await getOne('students', 'id', req.params.student_id);
        if (!student) return res.status(404).json({ error: 'طالب غير موجود' });
        res.json(student);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// تحديث بيانات الأستاذ
app.post('/api/teacher/update-profile', upload.single('profile_image'), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id } = req.body;

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
            .eq('id', parseInt(teacher_id))
            .select();

        if (error) throw error;

        res.json({ success: true, message: 'تم تحديث الصورة الشخصية', user: data[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// جلب بيانات أستاذ
app.get('/api/teacher/:teacher_id', async (req, res) => {
    try {
        const teacher = await getOne('teachers', 'id', req.params.teacher_id);
        if (!teacher) return res.status(404).json({ error: 'أستاذ غير موجود' });
        res.json(teacher);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// جلب جميع الأساتذة المقبولين
app.get('/api/teachers', async (req, res) => {
    try {
        const { data } = await supabase
            .from('teachers')
            .select('id, full_name, specialization, bio, experience, profile_image, profile_url')
            .eq('status', 'approved')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

// ============================================================
// تسجيل الدخول
// ============================================================
app.post('/api/login', [
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

        console.log(`محاولة تسجيل دخول: ${email} كـ ${role}`);

        // تسجيل دخول المشرف
        if (role === 'admin') {
            const adminPasswordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
            if (email === ADMIN_EMAIL && bcrypt.compareSync(password, adminPasswordHash)) {
                return res.json({
                    success: true,
                    token: 'admin_token',
                    user: { id: 0, name: 'مدير المنصة', role: 'admin' }
                });
            }
            return res.status(401).json({ success: false, error: 'بيانات الدخول غير صحيحة' });
        }

        // تسجيل دخول أستاذ أو طالب
        let user = await getOne('teachers', 'email', email);
        let userRole = 'teacher';

        if (!user) {
            user = await getOne('students', 'email', email);
            userRole = 'student';
        }

        if (!user) {
            return res.status(404).json({ success: false, error: 'البريد الإلكتروني غير موجود' });
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

        if (userRole === 'teacher' && user.status !== 'approved') {
            return res.status(403).json({ success: false, error: 'حسابك قيد المراجعة' });
        }

        res.json({
            success: true,
            token: `${userRole}_token`,
            user: {
                id: user.id,
                name: user.full_name,
                role: userRole,
                profile_image: user.profile_image,
                profile_url: user.profile_url,
                balance: user.wallet_balance || user.balance || 0
            }
        });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ADMIN Routes
// ============================================================
app.get('/api/admin/pending-teachers', async (req, res) => {
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

app.get('/api/admin/approved-teachers', async (req, res) => {
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

app.post('/api/admin/approve-teacher/:id', async (req, res) => {
    try {
        await update('teachers', req.params.id, { status: 'approved' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/reject-teacher/:id', async (req, res) => {
    try {
        const { reason } = req.body;
        await update('teachers', req.params.id, {
            status: 'rejected',
            rejection_reason: reason || 'لم يتم تحديد سبب'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/admin/delete-teacher/:id', async (req, res) => {
    try {
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// نظام العروض
// ============================================================
app.post('/api/offer/create', [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('subject_name').notEmpty().withMessage('اسم المادة مطلوب'),
    body('duration').isInt({ min: 1 }).withMessage('المدة غير صالحة'),
    body('offer_date').notEmpty().withMessage('تاريخ العرض مطلوب'),
    body('price').isFloat({ min: 0 }).withMessage('السعر غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, subject_name, duration, offer_date, price, is_free } = req.body;
        const room_name = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

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
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

app.get('/api/teacher/offers/:teacher_id', async (req, res) => {
    try {
        const { data } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', req.params.teacher_id)
            .order('offer_date', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.delete('/api/offer/delete/:offer_id', [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id } = req.body;
        const offer = await getOne('offers', 'id', req.params.offer_id);

        if (!offer || offer.teacher_id != teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح' });
        }

        await supabase.from('sessions').delete().eq('offer_id', req.params.offer_id);
        await supabase.from('waiting_room').delete().eq('offer_id', req.params.offer_id);
        await supabase.from('active_stream').delete().eq('offer_id', req.params.offer_id);
        await supabase.from('offers').delete().eq('id', req.params.offer_id);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// جلب حجوزات الطالب
app.get('/api/student/bookings/:student_id', async (req, res) => {
    try {
        const { data } = await supabase
            .from('sessions')
            .select('*, offers:offer_id (id, subject_name, offer_date, duration, price, is_free, status, room_name, teachers:teacher_id (id, full_name, profile_image, profile_url))')
            .eq('student_id', req.params.student_id)
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
app.get('/api/teacher/balance/:teacher_id', async (req, res) => {
    try {
        const teacher = await getOne('teachers', 'id', req.params.teacher_id);
        if (!teacher) return res.status(404).json({ error: 'أستاذ غير موجود' });

        const { data: paidSessions } = await supabase
            .from('sessions')
            .select('*, offers:offer_id (subject_name)')
            .eq('payment_status', 'paid')
            .eq('offer_id', req.params.teacher_id)
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

app.post('/api/teacher/withdraw-request', [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('amount').isFloat({ min: 1 }).withMessage('المبلغ غير صالح'),
    body('ccp_account').isLength({ min: 10 }).withMessage('رقم حساب CCP غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, amount, ccp_account } = req.body;

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
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/teacher/withdraw-requests/:teacher_id', async (req, res) => {
    try {
        const { data } = await supabase
            .from('withdraw_requests')
            .select('*')
            .eq('teacher_id', req.params.teacher_id)
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.get('/api/admin/withdraw-requests', async (req, res) => {
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

app.post('/api/admin/withdraw-requests/:id/approve', async (req, res) => {
    try {
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
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdraw-requests/:id/reject', async (req, res) => {
    try {
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// نظام البث المباشر
// ============================================================
app.post('/api/stream/enter-teacher/:offer_id', [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const { offer_id, teacher_id } = req.body;
        const offer = await getOne('offers', 'id', offer_id);

        if (!offer || offer.teacher_id != teacher_id) {
            return res.status(403).json({ success: false });
        }

        await update('offers', offer_id, { status: 'teacher_ready' });
        res.json({ success: true, room_name: offer.room_name });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/stream/add-students/:offer_id', [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const { offer_id, teacher_id } = req.body;
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
        res.status(500).json({ success: false });
    }
});

app.post('/api/stream/end/:offer_id', async (req, res) => {
    try {
        await update('offers', req.params.offer_id, { status: 'completed' });
        await supabase.from('active_stream').delete().eq('offer_id', req.params.offer_id);
        await supabase.from('waiting_room').delete().eq('offer_id', req.params.offer_id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
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

app.get('/api/student/stream-status/:offer_id/:student_id', async (req, res) => {
    try {
        const offer = await getOne('offers', 'id', req.params.offer_id);
        if (!offer) return res.json({ can_join: false, status: 'not_found' });

        if (offer.status === 'live') {
            const { data: active } = await supabase
                .from('active_stream')
                .select('*')
                .eq('offer_id', req.params.offer_id)
                .eq('student_id', req.params.student_id)
                .single();

            if (active) {
                await supabase
                    .from('notifications')
                    .update({ is_read: true })
                    .eq('offer_id', req.params.offer_id)
                    .eq('user_id', req.params.student_id);

                return res.json({ can_join: true, room_name: offer.room_name, status: 'live' });
            }
            return res.json({ can_join: false, status: 'not_active' });
        } else if (offer.status === 'teacher_ready') {
            const session = await getOne('sessions', 'offer_id', req.params.offer_id);
            if (session && session.payment_status === 'paid' && session.student_id == req.params.student_id) {
                const { data: existingWaiting } = await supabase
                    .from('waiting_room')
                    .select('*')
                    .eq('offer_id', req.params.offer_id)
                    .eq('student_id', req.params.student_id)
                    .maybeSingle();

                if (!existingWaiting) {
                    await insert('waiting_room', { offer_id: req.params.offer_id, student_id: req.params.student_id });
                }
                return res.json({ can_join: false, is_waiting: true, status: 'waiting' });
            }
            return res.json({ can_join: false, payment_required: true, status: 'payment_required' });
        } else if (offer.status === 'upcoming') {
            const session = await getOne('sessions', 'offer_id', req.params.offer_id);
            if (session && session.payment_status === 'paid' && session.student_id == req.params.student_id) {
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

app.get('/api/stream/waiting-list/:offer_id/:teacher_id', async (req, res) => {
    try {
        const { data } = await supabase
            .from('waiting_room')
            .select('*, students:student_id (full_name, email)')
            .eq('offer_id', req.params.offer_id);

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

app.get('/api/notifications/:user_id/:user_type', async (req, res) => {
    try {
        const { data } = await supabase
            .from('notifications')
            .select('*')
            .eq('user_id', req.params.user_id)
            .eq('user_type', req.params.user_type)
            .order('created_at', { ascending: false })
            .limit(30);

        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.post('/api/notifications/read/:notification_id', async (req, res) => {
    try {
        await update('notifications', req.params.notification_id, { is_read: true });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// ============================================================
// صفحات البث
// ============================================================
app.get('/api/teacher-stream/:offer_id/:teacher_id', async (req, res) => {
    const offer = await getOne('offers', 'id', req.params.offer_id);
    if (!offer || offer.teacher_id != req.params.teacher_id) {
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
            const roomName = '${offer.room_name}';
            const offerId = ${req.params.offer_id};
            const teacherId = ${req.params.teacher_id};

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
});

app.get('/api/enter-teacher-stream/:offer_id/:teacher_id', async (req, res) => {
    try {
        await axios.post(`http://localhost:${PORT}/api/stream/enter-teacher/${req.params.offer_id}`, {
            offer_id: parseInt(req.params.offer_id),
            teacher_id: parseInt(req.params.teacher_id)
        }).catch(e => console.log(e));
        res.redirect(`/api/teacher-stream/${req.params.offer_id}/${req.params.teacher_id}`);
    } catch (error) {
        res.redirect('/teacher-dashboard.html');
    }
});

app.get('/api/join-stream/:offer_id/:student_id', async (req, res) => {
    try {
        const offer = await getOne('offers', 'id', req.params.offer_id);
        if (!offer || offer.status !== 'live') {
            return res.redirect('/student-dashboard.html');
        }

        const { data: active } = await supabase
            .from('active_stream')
            .select('*')
            .eq('offer_id', req.params.offer_id)
            .eq('student_id', req.params.student_id)
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
    const captchaId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

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

// تنظيف الكابتشا المنتهية كل دقيقة
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
    body('title').notEmpty().withMessage('العنوان مطلوب'),
    body('message').notEmpty().withMessage('المحتوى مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { title, message } = req.body;

        const { data: students } = await supabase
            .from('students')
            .select('id');

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
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/sent-notifications', async (req, res) => {
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

app.delete('/api/admin/delete-notification/:id', async (req, res) => {
    try {
        await supabase
            .from('admin_notifications')
            .delete()
            .eq('id', req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// تحديث إشعار واحد كمقروء
// ============================================================
app.post('/api/notifications/read/:notification_id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('id', req.params.notification_id)
            .select();

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// تحديث ملف الأستاذ مع الروابط الاجتماعية
// ============================================================
app.post('/api/teacher/update-profile-with-social', upload.fields([
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
app.get('/api/admin/performance', async (req, res) => {
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
// تشغيل الخادم - متوافق مع Vercel و Render
// ============================================================

// تصدير التطبيق لـ Vercel (Serverless)
module.exports = app;

// للتشغيل المحلي فقط (عند تشغيل الملف مباشرة)
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`الخادم يعمل على http://localhost:${PORT}`);
        console.log('الامان: Helmet, CORS محدود, Rate Limiting');
        console.log('جميع المسارات محمية بالتحقق من المدخلات');
        console.log('Chargily API:', CHARGILY_API_URL);
        console.log('التاريخ:', new Date().toLocaleString('ar-EG'));
        console.log('='.repeat(60));
    });
}
