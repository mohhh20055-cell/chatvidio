// ============================================================
// مسارات الأستاذ - Teacher Routes (مبسط - بدون الدوال الجديدة)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');

const { supabase } = require('../config/database');
const { authenticate, authorize, checkBanned } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');
const { uploadToSupabase, validateUploadedFiles } = require('../utils/upload');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
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
// جلب معلومات الأستاذ الحالي (يجب أن يكون قبل /:teacher_id)
// ============================================================
router.get('/me', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacher = await getOne('teachers', 'id', req.user.userId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        delete teacher.password;

        // جلب البث النشط يدوياً (فقط الأعمدة الموجودة في قاعدة البيانات)
        const { data: activeOffer, error: activeError } = await supabase
            .from('offers')
            .select('id, subject_name, status, stream_url, room_password, booked_count, duration')
            .eq('teacher_id', req.user.userId)
            .in('status', ['live', 'teacher_ready', 'paused'])
            .single();

        let activeStream = null;
        if (activeOffer && !activeError) {
            activeStream = {
                id: activeOffer.id,
                subject_name: activeOffer.subject_name,
                status: activeOffer.status,
                stream_url: activeOffer.stream_url,
                room_password: activeOffer.room_password,
                duration: activeOffer.duration || 0,
                booked_count: activeOffer.booked_count || 0
            };
        }

        res.json({
            success: true,
            teacher: teacher,
            activeStream: activeStream
        });
    } catch (error) {
        console.error('خطأ في جلب بيانات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب بيانات الأستاذ
// ============================================================
router.get('/:teacher_id', authenticate, [
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
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        }
        
        delete teacher.password;
        
        res.json(teacher);
    } catch (error) {
        console.error('خطأ في جلب بيانات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث صورة الأستاذ
// ============================================================
router.post('/update-profile', authenticate, authorize(['teacher']), upload.single('profile_image'), validateUploadedFiles, [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id } = req.body;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'الرجاء اختيار صورة' });
        }

        const oldTeacher = await getOne('teachers', 'id', teacher_id);
        if (!oldTeacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        const uploaded = await uploadToSupabase(req.file, 'teachers', oldTeacher?.profile_image);
        if (!uploaded) {
            return res.status(500).json({ success: false, error: 'فشل رفع الصورة' });
        }

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

        res.json({ 
            success: true, 
            message: 'تم تحديث الصورة الشخصية بنجاح', 
            user: data ? data[0] : null 
        });
    } catch (error) {
        console.error('خطأ في تحديث الصورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث الملف الشخصي مع الروابط الاجتماعية
// ============================================================
router.post('/update-profile-with-social', authenticate, authorize(['teacher']), upload.fields([
    { name: 'profile_image', maxCount: 1 }
]), validateUploadedFiles, [
    body('teacher_id').isInt().withMessage('معرف الأستاذ مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { 
            teacher_id, 
            facebook_url, 
            instagram_url, 
            linkedin_url, 
            youtube_url, 
            twitter_url, 
            website_url, 
            whatsapp_url
        } = req.body;

        console.log('📝 تحديث الملف الشخصي للأستاذ:', teacher_id);

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        let profile_image = null;
        let profile_url = null;

        const oldTeacher = await getOne('teachers', 'id', teacher_id);
        if (!oldTeacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        if (req.files && req.files['profile_image'] && req.files['profile_image'][0]) {
            const file = req.files['profile_image'][0];
            const uploaded = await uploadToSupabase(file, 'teachers', oldTeacher?.profile_image);
            if (uploaded) {
                profile_image = uploaded.filename;
                profile_url = uploaded.url;
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
            website_url,
            whatsapp_url
        };

        for (const [key, value] of Object.entries(socialFields)) {
            if (value !== undefined && value !== null) {
                const cleaned = value.trim();
                if (cleaned && !cleaned.match(/^https?:\/\/.+/)) {
                    return res.status(400).json({ 
                        success: false, 
                        error: `الرابط ${key} غير صالح. يجب أن يبدأ بـ http:// أو https://` 
                    });
                }
                updateData[key] = cleaned === '' ? null : cleaned;
            }
        }

        console.log('💾 البيانات المراد تحديثها:', updateData);

        const { data, error } = await supabase
            .from('teachers')
            .update(updateData)
            .eq('id', teacher_id)
            .select();

        if (error) {
            console.error('❌ خطأ في تحديث قاعدة البيانات:', error);
            throw error;
        }

        const updatedTeacher = data ? data[0] : null;

        console.log('✅ تم تحديث الملف الشخصي بنجاح');

        res.json({
            success: true,
            message: 'تم تحديث الملف الشخصي وروابط التواصل الاجتماعي بنجاح',
            user: updatedTeacher
        });
    } catch (error) {
        console.error('❌ خطأ في تحديث الملف الشخصي:', error.message);
        console.error('📚 Stack:', error.stack);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ أثناء تحديث الملف الشخصي' });
    }
});

// ============================================================
// ✅ تحديث المستوى التعليمي فقط (للإدارة فقط)
// ============================================================
router.post('/update-teaching-level', authenticate, authorize(['admin']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ مطلوب'),
    body('teaching_level').notEmpty().withMessage('المستوى التعليمي مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, teaching_level } = req.body;

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        const { data, error } = await supabase
            .from('teachers')
            .update({ teaching_level: teaching_level.trim() })
            .eq('id', teacher_id)
            .select();

        if (error) throw error;

        res.json({
            success: true,
            message: 'تم تحديث المستوى التعليمي بنجاح',
            teaching_level: teaching_level,
            user: data ? data[0] : null
        });
    } catch (error) {
        console.error('❌ خطأ في تحديث المستوى التعليمي:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب الأساتذة مع فلتر المستوى التعليمي
// ============================================================
router.get('/public/teachers', async (req, res) => {
    try {
        const { level } = req.query;
        
        let query = supabase
            .from('teachers')
            .select('*')
            .eq('status', 'approved')
            .order('created_at', { ascending: false });

        if (level && level !== 'all') {
            query = query.eq('teaching_level', level);
        }

        const { data: teachers, error } = await query;

        if (error) throw error;

        const sanitized = (teachers || []).map(t => {
            delete t.password;
            return t;
        });

        res.json(sanitized);
    } catch (error) {
        console.error('خطأ في جلب الأساتذة:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب مستويات التعليم المتاحة
// ============================================================
router.get('/public/teaching-levels', async (req, res) => {
    try {
        const { data: teachers, error } = await supabase
            .from('teachers')
            .select('teaching_level')
            .eq('status', 'approved')
            .not('teaching_level', 'is', null);

        if (error) throw error;

        const levels = [...new Set(teachers.map(t => t.teaching_level).filter(Boolean))];
        
        const levelMap = {
            '5eme_pri': 'خامسة ابتدائي',
            '1ere_am': 'أولى متوسط',
            '2eme_am': 'ثانية متوسط',
            '3eme_am': 'ثالثة متوسط',
            '4eme_am': 'رابعة متوسط',
            '5eme_am': 'خامسة متوسط',
            '1ere_as': 'أولى ثانوي',
            'bac': 'بكالوريا',
            '1ere_uni': 'أولى جامعي',
            '2eme_uni': 'ثانية جامعي',
            '3eme_uni': 'ثالثة جامعي',
            'master': 'ماستر',
            'doctorat': 'دكتوراه'
        };

        const formattedLevels = levels.map(level => ({
            value: level,
            label: levelMap[level] || level
        }));

        res.json(formattedLevels);
    } catch (error) {
        console.error('خطأ في جلب مستويات التعليم:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب الرصيد والأرباح
// ============================================================
router.get('/balance/:teacher_id', authenticate, authorize(['teacher']), [
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
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        }

        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('id')
            .eq('teacher_id', teacher_id);

        if (offersError) {
            console.error('خطأ في جلب عروض الأستاذ:', offersError.message);
        }

        const offerIds = (offers || []).map(o => o.id);

        let paidSessions = [];
        if (offerIds.length > 0) {
            const { data: sessions, error: sessionsError } = await supabase
                .from('sessions')
                .select(`
                    *,
                    offers:offer_id (
                        subject_name,
                        teacher_id
                    )
                `)
                .in('offer_id', offerIds)
                .eq('payment_status', 'paid')
                .order('created_at', { ascending: false });

            if (sessionsError) {
                console.error('خطأ في جلب الجلسات:', sessionsError.message);
            } else {
                paidSessions = sessions || [];
            }
        }

        res.json({
            balance: teacher.balance || 0,
            total_earned: teacher.total_earned || 0,
            pending_withdraw: teacher.pending_withdraw || 0,
            total_withdrawn: teacher.total_withdrawn || 0,
            sessions: paidSessions
        });
    } catch (error) {
        console.error('خطأ في جلب الرصيد:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// طلب سحب
// ============================================================
router.post('/withdraw-request', authenticate, authorize(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('amount').isFloat({ min: 100, max: 1000000 }).withMessage('المبلغ غير صالح (الحد الأدنى 100 دج)'),
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
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'أستاذ غير موجود' });
        }

        if ((teacher.balance || 0) < amount) {
            return res.status(400).json({ 
                success: false, 
                error: `الرصيد غير كافٍ. رصيدك الحالي: ${teacher.balance} دج` 
            });
        }

        const { data: pendingRequest } = await supabase
            .from('withdraw_requests')
            .select('id')
            .eq('teacher_id', teacher_id)
            .eq('status', 'pending')
            .single();

        if (pendingRequest) {
            return res.status(400).json({ 
                success: false, 
                error: 'لديك طلب سحب معلق بالفعل، يرجى الانتظار حتى يتم معالجته' 
            });
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

        await insert('notifications', {
            user_id: teacher_id,
            user_type: 'teacher',
            title: '💰 طلب سحب جديد',
            message: `تم تقديم طلب سحب بمبلغ ${amount} دج إلى حساب CCP: ${ccp_account}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ 
            success: true, 
            message: 'تم تقديم طلب السحب بنجاح، سيتم معالجته في أقرب وقت',
            request: withdrawRequest 
        });
    } catch (error) {
        console.error('خطأ في طلب السحب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب طلبات السحب
// ============================================================
router.get('/withdraw-requests/:teacher_id', authenticate, authorize(['teacher']), [
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

        const { data, error } = await supabase
            .from('withdraw_requests')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب طلبات السحب:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب عروض الأستاذ
// ============================================================
router.get('/offers/:teacher_id', authenticate, authorize(['teacher']), [
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

        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.set('Pragma', 'no-cache');

        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('offer_date', { ascending: false });

        if (offersError) {
            console.error('خطأ في جلب العروض:', offersError.message);
            return res.status(500).json([]);
        }

        if (!offers || offers.length === 0) {
            return res.json([]);
        }

        const formatted = offers.map(offer => ({
            id: offer.id,
            teacher_id: offer.teacher_id,
            subject_name: offer.subject_name,
            duration: offer.duration,
            offer_date: offer.offer_date,
            price: offer.price,
            is_free: offer.is_free,
            status: offer.status,
            education_level: offer.education_level,
            room_name: offer.room_name || null,
            room_password: offer.room_password || null,
            stream_url: offer.stream_url || null,
            stream_platform: offer.stream_platform || 'jitsi',
            created_at: offer.created_at
        }));

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب عروض الأستاذ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب عرض محدد للأستاذ
// ============================================================
router.get('/offer/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذا العرض' });
        }

        const { count: studentsCount, error: countError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        if (countError) {
            console.error('خطأ في جلب عدد الطلاب:', countError.message);
        }

        res.json({
            ...offer,
            room_password: offer.room_password || null,
            jitsi_room_name: offer.room_name || null,
            jitsi_room_url: offer.stream_url || null,
            students_count: studentsCount || 0
        });
    } catch (error) {
        console.error('خطأ في جلب العرض:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث كلمة مرور العرض
// ============================================================
router.put('/offer/update-password/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('password').isLength({ min: 4, max: 10 }).withMessage('كلمة المرور يجب أن تكون بين 4 و 10 أحرف')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const { password } = req.body;

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        await update('offers', offer_id, {
            room_password: password
        });

        res.json({
            success: true,
            message: 'تم تحديث كلمة المرور بنجاح',
            new_password: password
        });
    } catch (error) {
        console.error('خطأ في تحديث كلمة المرور:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب إحصائيات الأستاذ
// ============================================================
router.get('/stats/:teacher_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);
        
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { count: totalOffers, error: offersError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('teacher_id', teacher_id);

        if (offersError) {
            console.error('خطأ في جلب عدد العروض:', offersError.message);
        }

        const { count: activeOffers, error: activeError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('teacher_id', teacher_id)
            .eq('status', 'live');

        if (activeError) {
            console.error('خطأ في جلب عدد العروض النشطة:', activeError.message);
        }

        const { data: offers, error: offersDataError } = await supabase
            .from('offers')
            .select('id')
            .eq('teacher_id', teacher_id);

        if (offersDataError) {
            console.error('خطأ في جلب عروض الأستاذ للإحصائيات:', offersDataError.message);
        }

        let totalStudents = 0;
        let completedSessions = 0;

        if (offers && offers.length > 0) {
            const offerIds = offers.map(o => o.id);

            const { count: studentsCount, error: studentsError } = await supabase
                .from('sessions')
                .select('*', { count: 'exact', head: true })
                .in('offer_id', offerIds)
                .eq('payment_status', 'paid');

            if (studentsError) {
                console.error('خطأ في جلب عدد الطلاب:', studentsError.message);
            } else {
                totalStudents = studentsCount || 0;
            }

            const { count: completedCount, error: completedError } = await supabase
                .from('sessions')
                .select('*', { count: 'exact', head: true })
                .in('offer_id', offerIds)
                .eq('payment_status', 'paid')
                .eq('completed', true);

            if (completedError) {
                console.error('خطأ في جلب عدد الحصص المكتملة:', completedError.message);
            } else {
                completedSessions = completedCount || 0;
            }
        }

        res.json({
            total_offers: totalOffers || 0,
            active_offers: activeOffers || 0,
            total_students: totalStudents,
            completed_sessions: completedSessions
        });
    } catch (error) {
        console.error('خطأ في جلب إحصائيات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب قائمة الطلاب المسجلين في عروض الأستاذ
// ============================================================
router.get('/students/:teacher_id', authenticate, authorize(['teacher']), [
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

        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('id, subject_name')
            .eq('teacher_id', teacher_id);

        if (offersError) {
            console.error('خطأ في جلب عروض الأستاذ:', offersError.message);
            return res.status(500).json([]);
        }

        if (!offers || offers.length === 0) {
            return res.json([]);
        }

        const offerIds = offers.map(o => o.id);

        const { data: sessions, error: sessionsError } = await supabase
            .from('sessions')
            .select(`
                id,
                student_id,
                offer_id,
                payment_status,
                created_at,
                students:student_id (
                    id,
                    full_name,
                    email,
                    phone,
                    education_level
                ),
                offers:offer_id (
                    subject_name
                )
            `)
            .in('offer_id', offerIds)
            .eq('payment_status', 'paid')
            .order('created_at', { ascending: false });

        if (sessionsError) {
            console.error('خطأ في جلب الجلسات:', sessionsError.message);
            return res.status(500).json([]);
        }

        const formatted = (sessions || []).map(session => ({
            session_id: session.id,
            student_id: session.student_id,
            student_name: session.students?.full_name || 'غير معروف',
            student_email: session.students?.email || '',
            student_phone: session.students?.phone || '',
            student_education_level: session.students?.education_level || '',
            offer_id: session.offer_id,
            offer_subject: session.offers?.subject_name || 'غير معروف',
            payment_status: session.payment_status,
            booked_at: session.created_at
        }));

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب طلاب الأستاذ:', error.message);
        res.status(500).json([]);
    }
});

module.exports = router;
