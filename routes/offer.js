// ============================================================
// مسارات العروض - Offer Routes (معدل بالكامل)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const crypto = require('crypto');

const { supabase } = require('../config/database');
// ✅ استيراد authorize من middleware مباشرة (بدون تعريف محلي)
const { authenticate, authorize, checkBanned } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');

// ============================================================
// ✅ إنشاء عرض جديد (معدل - مع كلمة مرور افتراضية)
// ============================================================
router.post('/offer/create', authenticate, authorize(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('subject_name').notEmpty().withMessage('اسم المادة مطلوب').isLength({ max: 100 }),
    body('duration').isInt({ min: 1, max: 360 }).withMessage('المدة غير صالحة (1-360 دقيقة)'),
    body('offer_date').notEmpty().withMessage('تاريخ العرض مطلوب').isISO8601().withMessage('تاريخ غير صالح'),
    body('price').isFloat({ min: 0, max: 1000000 }).withMessage('السعر غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, subject_name, duration, offer_date, price, is_free, education_level } = req.body;

        // ✅ التحقق من الصلاحية
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإنشاء عروض لهذا الحساب' });
        }

        // ✅ التحقق من وجود الأستاذ
        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        // ✅ التحقق من أن الأستاذ معتمد
        if (teacher.status !== 'approved') {
            return res.status(403).json({ success: false, error: 'حسابك غير معتمد بعد، يرجى الانتظار حتى مراجعة الإدارة' });
        }

        // ✅ إنشاء اسم الغرفة وكلمة المرور الافتراضية
        const room_name = `stream_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const defaultPassword = crypto.randomBytes(4).toString('hex').toUpperCase();

        // ✅ إنشاء العرض
        const newOffer = await insert('offers', {
            teacher_id,
            subject_name: subject_name.trim(),
            duration: parseInt(duration),
            offer_date: new Date(offer_date).toISOString(),
            price: parseFloat(price) || 0,
            is_free: is_free ? true : false,
            room_name,
            room_password: defaultPassword,
            status: 'upcoming',
            education_level: education_level || null,
            created_at: new Date().toISOString()
        });

        // ✅ إنشاء غرفة Jitsi في قاعدة البيانات
        try {
            await supabase
                .from('jitsi_rooms')
                .insert({
                    offer_id: newOffer.id,
                    room_name: room_name,
                    password: defaultPassword,
                    room_url: `https://meet.jit.si/${room_name}`,
                    created_at: new Date().toISOString()
                });
        } catch (jitsiError) {
            console.error('خطأ في إنشاء غرفة Jitsi:', jitsiError.message);
            // لا نوقف العملية إذا فشل إنشاء الغرفة
        }

        res.json({ 
            success: true, 
            message: 'تم إنشاء العرض بنجاح',
            room_name,
            default_password: defaultPassword,
            offer: {
                id: newOffer.id,
                subject_name: newOffer.subject_name,
                duration: newOffer.duration,
                offer_date: newOffer.offer_date,
                price: newOffer.price,
                is_free: newOffer.is_free,
                status: newOffer.status,
                education_level: newOffer.education_level,
                room_password: defaultPassword
            }
        });
    } catch (error) {
        console.error('خطأ في إنشاء العرض:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء إنشاء العرض' });
    }
});

// ============================================================
// ✅ جلب جميع العروض القادمة (معدل - مع كلمة المرور)
// ============================================================
router.get('/offers', async (req, res) => {
    try {
        const now = new Date().toISOString();
        
        const { data, error } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_image, profile_url)')
            .eq('status', 'upcoming')
            .gt('offer_date', now)
            .order('offer_date', { ascending: true });

        if (error) throw error;

        // ✅ تنسيق البيانات مع إضافة معلومات المعلم
        const formatted = (data || []).map(o => ({
            id: o.id,
            teacher_id: o.teacher_id,
            subject_name: o.subject_name,
            duration: o.duration,
            offer_date: o.offer_date,
            price: o.price,
            is_free: o.is_free,
            status: o.status,
            education_level: o.education_level,
            room_password: o.room_password || null,
            room_name: o.room_name || null,
            created_at: o.created_at,
            teacher_name: o.teachers?.full_name || 'غير معروف',
            teacher_specialization: o.teachers?.specialization || '',
            teacher_profile_image: o.teachers?.profile_image || null,
            teacher_profile_url: o.teachers?.profile_url || null
        }));

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب العروض:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب العروض المباشرة (معدل - مع كلمة المرور)
// ============================================================
router.get('/live-offers', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_url)')
            .in('status', ['live', 'teacher_ready'])
            .order('offer_date', { ascending: false })
            .limit(50);

        if (error) throw error;

        // ✅ جلب كلمات المرور من جدول jitsi_rooms
        const offerIds = (data || []).map(o => o.id);
        let jitsiRooms = {};
        if (offerIds.length > 0) {
            const { data: jitsiData } = await supabase
                .from('jitsi_rooms')
                .select('offer_id, password, room_name, room_url')
                .in('offer_id', offerIds);
            
            jitsiRooms = (jitsiData || []).reduce((acc, room) => {
                acc[room.offer_id] = room;
                return acc;
            }, {});
        }

        const formatted = (data || []).map(o => {
            const jitsi = jitsiRooms[o.id] || {};
            return {
                id: o.id,
                teacher_id: o.teacher_id,
                subject_name: o.subject_name,
                duration: o.duration,
                offer_date: o.offer_date,
                price: o.price,
                is_free: o.is_free,
                status: o.status,
                education_level: o.education_level,
                stream_url: o.stream_url || jitsi.room_url || null,
                stream_platform: o.stream_platform || 'jitsi',
                room_password: o.room_password || jitsi.password || null,
                room_name: o.room_name || jitsi.room_name || null,
                created_at: o.created_at,
                teacher_name: o.teachers?.full_name || 'غير معروف',
                teacher_specialization: o.teachers?.specialization || '',
                teacher_profile_url: o.teachers?.profile_url || null
            };
        });

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب العروض المباشرة:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب عرض محدد (معدل - مع كلمة المرور)
// ============================================================
router.get('/offer/:offer_id', async (req, res) => {
    try {
        const offer_id = parseInt(req.params.offer_id);
        
        const { data: offer, error } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_image, profile_url)')
            .eq('id', offer_id)
            .single();

        if (error || !offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        // ✅ جلب كلمة المرور من جدول jitsi_rooms إذا كانت موجودة
        const { data: jitsiRoom } = await supabase
            .from('jitsi_rooms')
            .select('password, room_name, room_url')
            .eq('offer_id', offer_id)
            .single();

        // ✅ جلب عدد الطلاب المسجلين
        const { count: studentsCount } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        // ✅ جلب قائمة الطلاب المسجلين
        const { data: students } = await supabase
            .from('sessions')
            .select('student_id, students:student_id (id, full_name, email, profile_url)')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        res.json({
            id: offer.id,
            teacher_id: offer.teacher_id,
            subject_name: offer.subject_name,
            duration: offer.duration,
            offer_date: offer.offer_date,
            price: offer.price,
            is_free: offer.is_free,
            status: offer.status,
            education_level: offer.education_level,
            stream_url: offer.stream_url || jitsiRoom?.room_url || null,
            stream_platform: offer.stream_platform || 'jitsi',
            room_password: jitsiRoom?.password || offer.room_password || null,
            room_name: jitsiRoom?.room_name || offer.room_name || null,
            created_at: offer.created_at,
            teacher_name: offer.teachers?.full_name || 'غير معروف',
            teacher_specialization: offer.teachers?.specialization || '',
            teacher_profile_image: offer.teachers?.profile_image || null,
            teacher_profile_url: offer.teachers?.profile_url || null,
            students_count: studentsCount || 0,
            students: students || []
        });
    } catch (error) {
        console.error('خطأ في جلب العرض:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ تحديث كلمة مرور العرض (ميزة جديدة)
// ============================================================
router.put('/offer/update-password/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('password').isLength({ min: 4, max: 10 }).withMessage('كلمة المرور يجب أن تكون بين 4 و 10 أحرف')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const { teacher_id, password } = req.body;

        // ✅ التحقق من الصلاحية
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ التحقق من وجود العرض
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث كلمة مرور هذا العرض' });
        }

        // ✅ تحديث كلمة المرور في جدول offers
        await update('offers', offer_id, { room_password: password });

        // ✅ تحديث كلمة المرور في جدول jitsi_rooms إذا كانت موجودة
        const { data: jitsiRoom } = await supabase
            .from('jitsi_rooms')
            .select('id')
            .eq('offer_id', offer_id)
            .single();

        if (jitsiRoom) {
            await supabase
                .from('jitsi_rooms')
                .update({ password: password })
                .eq('id', jitsiRoom.id);
        }

        // ✅ تحديث كلمات المرور الفردية للطلاب (إذا أردت)
        // يمكن إعادة تعيين كلمات المرور الفردية أو تركها كما هي

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
// ✅ حذف عرض
// ============================================================
router.delete('/offer/delete/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const { teacher_id } = req.body;

        // ✅ التحقق من الصلاحية
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذا العرض' });
        }

        // ✅ التحقق من وجود العرض
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذا العرض' });
        }

        // ✅ التحقق من أن العرض ليس قيد البث
        if (offer.status === 'live' || offer.status === 'teacher_ready') {
            return res.status(400).json({ 
                success: false, 
                error: 'لا يمكن حذف العرض أثناء البث المباشر' 
            });
        }

        // ✅ حذف البيانات المرتبطة بالعرض
        const tables = [
            'student_room_passwords',
            'jitsi_rooms',
            'sessions',
            'waiting_room',
            'active_stream'
        ];

        for (const table of tables) {
            try {
                await supabase
                    .from(table)
                    .delete()
                    .eq('offer_id', offer_id);
            } catch (deleteError) {
                console.error(`خطأ في حذف البيانات من ${table}:`, deleteError.message);
            }
        }

        // ✅ حذف العرض نفسه
        await supabase
            .from('offers')
            .delete()
            .eq('id', offer_id);

        res.json({ 
            success: true, 
            message: 'تم حذف العرض وجميع البيانات المرتبطة به بنجاح'
        });
    } catch (error) {
        console.error('خطأ في حذف العرض:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ عدد المنتظرين في العرض
// ============================================================
router.get('/waiting-count/:offer_id', async (req, res) => {
    try {
        const offer_id = parseInt(req.params.offer_id);
        
        const { count, error } = await supabase
            .from('waiting_room')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id);

        if (error) throw error;

        res.json({ count: count || 0 });
    } catch (error) {
        console.error('خطأ في جلب عدد المنتظرين:', error.message);
        res.json({ count: 0 });
    }
});

// ============================================================
// ✅ جلب عروض الأستاذ (للوحة التحكم)
// ============================================================
router.get('/teacher/offers/:teacher_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);
        
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data, error } = await supabase
            .from('offers')
            .select('*, jitsi_rooms!left(offer_id) (password, room_name, room_url)')
            .eq('teacher_id', teacher_id)
            .order('offer_date', { ascending: false });

        if (error) throw error;

        // ✅ تنسيق البيانات مع كلمات المرور
        const formatted = (data || []).map(offer => {
            const jitsiData = offer.jitsi_rooms || {};
            return {
                ...offer,
                jitsi_rooms: undefined,
                room_password: jitsiData.password || offer.room_password || null,
                jitsi_room_name: jitsiData.room_name || null,
                jitsi_room_url: jitsiData.room_url || null,
                stream_url: offer.stream_url || jitsiData.room_url || null
            };
        });

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب عروض الأستاذ:', error.message);
        res.status(500).json([]);
    }
});

module.exports = router;
