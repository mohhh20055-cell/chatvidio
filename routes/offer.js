// ============================================================
// مسارات العروض
// ============================================================

const express = require('express');
const router = express.Router();
const { body, validationResult, param } = require('express-validator');
const crypto = require('crypto');

// استيراد الدوال المساعدة من الملف الرئيسي
const server = require('../server');

// استخراج الدوال من server
const { 
    authenticate, 
    authorize, 
    getOne, 
    insert, 
    update, 
    remove,
    supabase,
    sanitizeInput
} = server;

// ============================================================
// إنشاء عرض جديد
// ============================================================
router.post('/offer/create', [
    authenticate,
    authorize(['teacher']),
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
            price,
            is_free: is_free ? 1 : 0,
            room_name,
            status: 'upcoming',
            education_level: education_level || null
        });

        res.json({ success: true, room_name });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب جميع العروض المتاحة
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
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب العروض العامة
// ============================================================
router.get('/public/offers', async (req, res) => {
    try {
        const { data } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_url)')
            .eq('status', 'upcoming')
            .gt('offer_date', new Date().toISOString())
            .order('offer_date', { ascending: true })
            .limit(50);
        res.json(data || []);
    } catch (error) {
        console.error('خطأ:', error.message);
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
        console.error('خطأ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب عروض أستاذ معين
// ============================================================
router.get('/teacher/offers/:teacher_id', [
    authenticate,
    authorize(['teacher']),
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

        const { data } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('offer_date', { ascending: false });
        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

// ============================================================
// حذف عرض
// ============================================================
router.delete('/offer/delete/:offer_id', [
    authenticate,
    authorize(['teacher']),
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
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// عدد الطلاب في قائمة الانتظار
// ============================================================
router.get('/waiting-count/:offer_id', async (req, res) => {
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
// إحصائيات العروض العامة
// ============================================================
router.get('/public/stats', async (req, res) => {
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
        console.error('خطأ:', error.message);
        res.status(500).json({ teachers: 0, offers: 0, live: 0, students: 0 });
    }
});

// ============================================================
// إجمالي عدد العروض
// ============================================================
router.get('/public/total-offers', async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true });
        
        if (error) {
            return res.status(500).json({ total: 0, error: error.message });
        }
        
        res.json({ total: count || 0 });
    } catch (error) {
        console.error('❌ خطأ في جلب عدد الدروس:', error.message);
        res.status(500).json({ total: 0 });
    }
});

module.exports = router;
