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
// إنشاء عرض جديد
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

        await insert('offers', {
            teacher_id,
            subject_name: subject_name.trim(),
            duration,
            offer_date,
            price: price || 0,
            is_free: is_free ? true : false,
            room_name,
            status: 'upcoming',
            education_level: education_level || null
        });

        res.json({ success: true, room_name });
    } catch (error) {
        console.error('خطأ في إنشاء العرض:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب جميع العروض القادمة
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
            teacher_id: o.teachers?.id
        }));

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب العروض:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب العروض المباشرة
// ============================================================
router.get('/live-offers', async (req, res) => {
    try {
        const { data } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_url)')
            .eq('status', 'live')
            .order('offer_date', { ascending: false })
            .limit(20);
        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب العروض المباشرة:', error.message);
        res.status(500).json([]);
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
