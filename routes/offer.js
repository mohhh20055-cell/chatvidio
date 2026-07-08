// ============================================================
// مسارات العروض - Offer Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const crypto = require('crypto');

const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');

// ✅ تعريف authorize محلياً
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

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإنشاء عروض لهذا الحساب' });
        }

        const room_name = `stream_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        
        // ✅ إنشاء كلمة مرور افتراضية للغرفة (لـ Jitsi)
        const defaultPassword = crypto.randomBytes(4).toString('hex').toUpperCase();

        const newOffer = await insert('offers', {
            teacher_id,
            subject_name: subject_name.trim(),
            duration,
            offer_date,
            price: price || 0,
            is_free: is_free ? true : false,
            room_name,
            room_password: defaultPassword, // ✅ إضافة كلمة المرور الافتراضية
            status: 'upcoming',
            education_level: education_level || null
        });

        res.json({ 
            success: true, 
            room_name,
            default_password: defaultPassword,
            offer: newOffer
        });
    } catch (error) {
        console.error('خطأ في إنشاء العرض:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب جميع العروض القادمة (معدل - مع كلمة المرور)
// ============================================================
router.get('/offers', async (req, res) => {
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
            teacher_id: o.teachers?.id,
            // ✅ إضافة كلمة المرور (إذا كانت موجودة)
            room_password: o.room_password || null
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
        const { data } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_url)')
            .eq('status', 'live')
            .order('offer_date', { ascending: false })
            .limit(20);

        const formatted = (data || []).map(o => ({
            ...o,
            teacher_name: o.teachers?.full_name,
            teacher_specialization: o.teachers?.specialization,
            teacher_profile_url: o.teachers?.profile_url,
            teacher_id: o.teachers?.id,
            // ✅ إضافة كلمة المرور (إذا كانت موجودة)
            room_password: o.room_password || null,
            stream_url: o.stream_url || null,
            stream_platform: o.stream_platform || 'jitsi'
        }));

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
        const { data: offer } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_image, profile_url)')
            .eq('id', req.params.offer_id)
            .single();

        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        // ✅ جلب كلمة المرور من جدول jitsi_rooms إذا كانت موجودة
        const { data: jitsiRoom } = await supabase
            .from('jitsi_rooms')
            .select('password, room_name')
            .eq('offer_id', offer.id)
            .single();

        res.json({
            ...offer,
            teacher_name: offer.teachers?.full_name,
            teacher_specialization: offer.teachers?.specialization,
            teacher_profile_image: offer.teachers?.profile_image,
            teacher_profile_url: offer.teachers?.profile_url,
            teacher_id: offer.teachers?.id,
            room_password: jitsiRoom?.password || offer.room_password || null,
            jitsi_room_name: jitsiRoom?.room_name || null
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

        const { offer_id, teacher_id, password } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer || offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح' });
        }

        // ✅ تحديث كلمة المرور
        await update('offers', offer_id, { room_password: password });

        // ✅ إذا كانت هناك غرفة Jitsi، تحديث كلمة المرور فيها أيضاً
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
// حذف عرض
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

        const { teacher_id } = req.body;
        const offer_id = parseInt(req.params.offer_id);

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذا العرض' });
        }

        const offer = await getOne('offers', 'id', offer_id);

        if (!offer || offer.teacher_id != teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح' });
        }

        // ✅ حذف كلمات المرور المرتبطة
        await supabase.from('student_room_passwords').delete().eq('offer_id', offer_id);
        await supabase.from('jitsi_rooms').delete().eq('offer_id', offer_id);
        await supabase.from('sessions').delete().eq('offer_id', offer_id);
        await supabase.from('waiting_room').delete().eq('offer_id', offer_id);
        await supabase.from('active_stream').delete().eq('offer_id', offer_id);
        await supabase.from('offers').delete().eq('id', offer_id);

        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في حذف العرض:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// عدد المنتظرين في العرض
// ============================================================
router.get('/waiting-count/:offer_id', async (req, res) => {
    try {
        const { count } = await supabase
            .from('waiting_room')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', req.params.offer_id);
        res.json({ count: count || 0 });
    } catch (error) {
        console.error('خطأ في جلب عدد المنتظرين:', error.message);
        res.json({ count: 0 });
    }
});

module.exports = router;
