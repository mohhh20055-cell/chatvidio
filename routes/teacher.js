// ============================================================
// مسارات الأستاذ - Teacher Routes (معدل بالكامل مع دعم نظام البث)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');

const { supabase } = require('../config/database');
const { authenticate, authorize, checkBanned, checkActiveStream, isOwner, validateOfferOwnership } = require('../middleware/auth');
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
// ✅ جلب بيانات الأستاذ (مع معلومات البث النشط)
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

        // ✅ جلب معلومات البث النشط
        const { data: activeOffer, error: activeError } = await supabase
            .from('offers')
            .select('id, subject_name, status, stream_url, room_password, remaining_seconds, total_seconds, is_paused, booked_count')
            .eq('teacher_id', teacher_id)
            .in('status', ['live', 'teacher_ready', 'paused'])
            .single();

        let activeStream = null;
        if (activeOffer && !activeError) {
            // حساب الوقت المتبقي
            let remainingSeconds = activeOffer.remaining_seconds || 0;
            if (activeOffer.status === 'live' && !activeOffer.is_paused && activeOffer.stream_started_at) {
                const startedAt = new Date(activeOffer.stream_started_at);
                const now = new Date();
                const elapsed = Math.floor((now - startedAt) / 1000);
                const total = activeOffer.total_seconds || (activeOffer.duration * 60);
                remainingSeconds = Math.max(0, total - elapsed);
            }

            activeStream = {
                id: activeOffer.id,
                subject_name: activeOffer.subject_name,
                status: activeOffer.status,
                stream_url: activeOffer.stream_url,
                room_password: activeOffer.room_password,
                total_seconds: activeOffer.total_seconds || 0,
                remaining_seconds: remainingSeconds,
                is_paused: activeOffer.is_paused || false,
                booked_count: activeOffer.booked_count || 0
            };
        }

        res.json({
            ...teacher,
            active_stream: activeStream
        });
    } catch (error) {
        console.error('خطأ في جلب بيانات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب معلومات الأستاذ الحالي (مع البث النشط)
// ============================================================
router.get('/me', authenticate, authorize(['teacher']), checkActiveStream, async (req, res) => {
    try {
        const teacher = await getOne('teachers', 'id', req.user.userId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        delete teacher.password;

        // ✅ req.activeStream متاح من checkActiveStream
        res.json({
            ...teacher,
            active_stream: req.activeStream || null
        });
    } catch (error) {
        console.error('خطأ في جلب معلومات الأستاذ:', error.message);
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

        // روابط التواصل الاجتماعي
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
// ✅ جلب الأساتذة مع فلتر المستوى التعليمي (للواجهة الأمامية)
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

        // إزالة كلمات المرور
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
// ✅ جلب مستويات التعليم المتاحة (للتصفية في الواجهة الأمامية)
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
// ✅ جلب الرصيد والأرباح (مع الرصيد المعلق)
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
        let pendingSessions = [];
        let totalPendingBalance = 0;

        if (offerIds.length > 0) {
            // ✅ جلب الجلسات المدفوعة
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

            // ✅ جلب الرصيد المعلق
            const { data: pending, error: pendingError } = await supabase
                .from('sessions')
                .select('pending_balance')
                .in('offer_id', offerIds)
                .eq('payment_status', 'pending_stream');

            if (!pendingError && pending) {
                totalPendingBalance = pending.reduce((sum, s) => sum + (s.pending_balance || 0), 0);
                pendingSessions = pending;
            }
        }

        // ✅ جلب عدد الطلاب في البث النشط
        let activeStudents = 0;
        const { data: activeOffer, error: activeError } = await supabase
            .from('offers')
            .select('id')
            .eq('teacher_id', teacher_id)
            .in('status', ['live', 'teacher_ready'])
            .single();

        if (activeOffer && !activeError) {
            const { count, error: countError } = await supabase
                .from('active_stream')
                .select('*', { count: 'exact', head: true })
                .eq('offer_id', activeOffer.id);

            if (!countError) {
                activeStudents = count || 0;
            }
        }

        res.json({
            balance: teacher.balance || 0,
            total_earned: teacher.total_earned || 0,
            pending_withdraw: teacher.pending_withdraw || 0,
            total_withdrawn: teacher.total_withdrawn || 0,
            total_pending_balance: totalPendingBalance,
            active_students: activeStudents,
            sessions: paidSessions,
            pending_sessions: pendingSessions
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

        // ✅ التحقق من الرصيد (باستثناء الرصيد المعلق)
        const availableBalance = (teacher.balance || 0) - (teacher.pending_withdraw || 0);
        if (availableBalance < amount) {
            return res.status(400).json({ 
                success: false, 
                error: `الرصيد المتاح للسحب غير كافٍ. رصيدك المتاح: ${availableBalance} دج` 
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
// ✅ جلب عروض الأستاذ (مع معلومات البث)
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

        const formatted = offers.map(offer => {
            // حساب الوقت المتبقي للعروض المباشرة
            let remainingSeconds = offer.remaining_seconds || 0;
            if (offer.status === 'live' && !offer.is_paused && offer.stream_started_at) {
                const startedAt = new Date(offer.stream_started_at);
                const now = new Date();
                const elapsed = Math.floor((now - startedAt) / 1000);
                const total = offer.total_seconds || (offer.duration * 60);
                remainingSeconds = Math.max(0, total - elapsed);
            }

            return {
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
                total_seconds: offer.total_seconds || (offer.duration * 60),
                remaining_seconds: remainingSeconds,
                is_paused: offer.is_paused || false,
                booked_count: offer.booked_count || 0,
                created_at: offer.created_at,
                updated_at: offer.updated_at
            };
        });

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب عروض الأستاذ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب عرض محدد للأستاذ (مع معلومات البث)
// ============================================================
router.get('/offer/:offer_id', authenticate, authorize(['teacher']), validateOfferOwnership, [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        // ✅ req.offer متاح من validateOfferOwnership
        const offer = req.offer;

        // ✅ جلب عدد الطلاب المسجلين
        const { count: studentsCount, error: countError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer.id)
            .in('payment_status', ['paid', 'pending_stream']);

        if (countError) {
            console.error('خطأ في جلب عدد الطلاب:', countError.message);
        }

        // ✅ جلب الرصيد المعلق للعرض
        const { data: pendingData, error: pendingError } = await supabase
            .from('sessions')
            .select('pending_balance')
            .eq('offer_id', offer.id)
            .eq('payment_status', 'pending_stream');

        let totalPendingBalance = 0;
        if (!pendingError && pendingData) {
            totalPendingBalance = pendingData.reduce((sum, s) => sum + (s.pending_balance || 0), 0);
        }

        // ✅ حساب الوقت المتبقي
        let remainingSeconds = offer.remaining_seconds || 0;
        if (offer.status === 'live' && !offer.is_paused && offer.stream_started_at) {
            const startedAt = new Date(offer.stream_started_at);
            const now = new Date();
            const elapsed = Math.floor((now - startedAt) / 1000);
            const total = offer.total_seconds || (offer.duration * 60);
            remainingSeconds = Math.max(0, total - elapsed);
        }

        res.json({
            ...offer,
            room_password: offer.room_password || null,
            jitsi_room_name: offer.room_name || null,
            jitsi_room_url: offer.stream_url || null,
            total_seconds: offer.total_seconds || (offer.duration * 60),
            remaining_seconds: remainingSeconds,
            is_paused: offer.is_paused || false,
            students_count: studentsCount || 0,
            total_pending_balance: totalPendingBalance,
            booked_count: offer.booked_count || 0
        });
    } catch (error) {
        console.error('خطأ في جلب العرض:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث كلمة مرور العرض
// ============================================================
router.put('/offer/update-password/:offer_id', authenticate, authorize(['teacher']), validateOfferOwnership, [
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

        // ✅ req.offer متاح من validateOfferOwnership
        const offer = req.offer;

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
// ✅ جلب إحصائيات الأستاذ (مع البث النشط)
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

        // ✅ جلب العروض النشطة (بث مباشر)
        const { count: activeOffers, error: activeError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('teacher_id', teacher_id)
            .in('status', ['live', 'teacher_ready']);

        if (activeError) {
            console.error('خطأ في جلب عدد العروض النشطة:', activeError.message);
        }

        // ✅ جلب العروض المتوقفة مؤقتاً
        const { count: pausedOffers, error: pausedError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('teacher_id', teacher_id)
            .eq('status', 'paused');

        if (pausedError) {
            console.error('خطأ في جلب العروض المتوقفة:', pausedError.message);
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
        let totalPendingBalance = 0;

        if (offers && offers.length > 0) {
            const offerIds = offers.map(o => o.id);

            // ✅ عدد الطلاب
            const { count: studentsCount, error: studentsError } = await supabase
                .from('sessions')
                .select('*', { count: 'exact', head: true })
                .in('offer_id', offerIds)
                .in('payment_status', ['paid', 'pending_stream']);

            if (studentsError) {
                console.error('خطأ في جلب عدد الطلاب:', studentsError.message);
            } else {
                totalStudents = studentsCount || 0;
            }

            // ✅ الحصص المكتملة
            const { count: completedCount, error: completedError } = await supabase
                .from('sessions')
                .select('*', { count: 'exact', head: true })
                .in('offer_id', offerIds)
                .eq('payment_status', 'paid');

            if (completedError) {
                console.error('خطأ في جلب عدد الحصص المكتملة:', completedError.message);
            } else {
                completedSessions = completedCount || 0;
            }

            // ✅ الرصيد المعلق
            const { data: pendingData, error: pendingError } = await supabase
                .from('sessions')
                .select('pending_balance')
                .in('offer_id', offerIds)
                .eq('payment_status', 'pending_stream');

            if (!pendingError && pendingData) {
                totalPendingBalance = pendingData.reduce((sum, s) => sum + (s.pending_balance || 0), 0);
            }
        }

        // ✅ جلب عدد الطلاب في البث النشط
        let activeStudents = 0;
        const { data: activeOffer, error: activeOfferError } = await supabase
            .from('offers')
            .select('id')
            .eq('teacher_id', teacher_id)
            .in('status', ['live', 'teacher_ready'])
            .single();

        if (activeOffer && !activeOfferError) {
            const { count, error: countError } = await supabase
                .from('active_stream')
                .select('*', { count: 'exact', head: true })
                .eq('offer_id', activeOffer.id);

            if (!countError) {
                activeStudents = count || 0;
            }
        }

        res.json({
            total_offers: totalOffers || 0,
            active_offers: activeOffers || 0,
            paused_offers: pausedOffers || 0,
            total_students: totalStudents,
            active_students: activeStudents,
            completed_sessions: completedSessions,
            total_pending_balance: totalPendingBalance
        });
    } catch (error) {
        console.error('خطأ في جلب إحصائيات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب قائمة الطلاب المسجلين في عروض الأستاذ (مع حالة البث)
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

        // جلب جميع عروض الأستاذ
        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('id, subject_name, status')
            .eq('teacher_id', teacher_id);

        if (offersError) {
            console.error('خطأ في جلب عروض الأستاذ:', offersError.message);
            return res.status(500).json([]);
        }

        if (!offers || offers.length === 0) {
            return res.json([]);
        }

        const offerIds = offers.map(o => o.id);

        // جلب جميع الجلسات
        const { data: sessions, error: sessionsError } = await supabase
            .from('sessions')
            .select(`
                id,
                student_id,
                offer_id,
                payment_status,
                pending_balance,
                created_at,
                students:student_id (
                    id,
                    full_name,
                    email,
                    phone,
                    education_level
                ),
                offers:offer_id (
                    subject_name,
                    status
                )
            `)
            .in('offer_id', offerIds)
            .in('payment_status', ['paid', 'pending_stream'])
            .order('created_at', { ascending: false });

        if (sessionsError) {
            console.error('خطأ في جلب الجلسات:', sessionsError.message);
            return res.status(500).json([]);
        }

        // تنسيق البيانات
        const formatted = (sessions || []).map(session => ({
            session_id: session.id,
            student_id: session.student_id,
            student_name: session.students?.full_name || 'غير معروف',
            student_email: session.students?.email || '',
            student_phone: session.students?.phone || '',
            student_education_level: session.students?.education_level || '',
            offer_id: session.offer_id,
            offer_subject: session.offers?.subject_name || 'غير معروف',
            offer_status: session.offers?.status || 'unknown',
            payment_status: session.payment_status,
            pending_balance: session.pending_balance || 0,
            is_pending: session.payment_status === 'pending_stream',
            booked_at: session.created_at
        }));

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب طلاب الأستاذ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب معلومات البث النشط للأستاذ
// ============================================================
router.get('/active-stream', authenticate, authorize(['teacher']), checkActiveStream, async (req, res) => {
    try {
        // ✅ req.activeStream متاح من checkActiveStream
        if (!req.activeStream) {
            return res.json({
                success: true,
                has_active_stream: false,
                stream: null
            });
        }

        // جلب معلومات إضافية
        const { data: students, error: studentsError } = await supabase
            .from('active_stream')
            .select('student_id, students:student_id (id, full_name, email, profile_url)')
            .eq('offer_id', req.activeStream.id);

        let studentList = [];
        if (!studentsError && students) {
            studentList = students.map(s => ({
                id: s.students?.id,
                full_name: s.students?.full_name,
                email: s.students?.email,
                profile_url: s.students?.profile_url
            }));
        }

        res.json({
            success: true,
            has_active_stream: true,
            stream: {
                ...req.activeStream,
                students: studentList,
                students_count: studentList.length
            }
        });
    } catch (error) {
        console.error('خطأ في جلب البث النشط:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
