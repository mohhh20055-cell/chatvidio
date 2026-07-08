// ============================================================
// مسارات الطالب - Student Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');

const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');
const { uploadToSupabase, validateUploadedFiles } = require('../utils/upload');

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
// جلب بيانات الطالب
// ============================================================
router.get('/:student_id', authenticate, [
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المعلومات' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) return res.status(404).json({ success: false, error: 'طالب غير موجود' });
        
        delete student.password;
        
        res.json(student);
    } catch (error) {
        console.error('خطأ في جلب بيانات الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث ملف الطالب
// ============================================================
router.post('/update-profile', authenticate, authorize(['student']), upload.single('profile_image'), validateUploadedFiles, [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, full_name, phone } = req.body;

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

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
            .eq('id', student_id)
            .select();

        if (error) throw error;

        res.json({ success: true, message: 'تم تحديث الملف الشخصي', user: data[0] });
    } catch (error) {
        console.error('خطأ في تحديث ملف الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب حجوزات الطالب
// ============================================================
router.get('/bookings/:student_id', authenticate, authorize(['student']), [
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه الحجوزات' });
        }

        const { data } = await supabase
            .from('sessions')
            .select('*, offers:offer_id (id, subject_name, offer_date, duration, price, is_free, status, room_name, teachers:teacher_id (id, full_name, profile_image, profile_url))')
            .eq('student_id', student_id)
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

// ============================================================
// ✅ جلب حالة البث للطالب (معدل)
// ============================================================
router.get('/stream-status/:offer_id/:student_id', authenticate, authorize(['student']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, student_id } = req.params;

        if (req.user.userId !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ التحقق من أن الطالب لديه حجز مدفوع
        const session = await getOne('sessions', 'offer_id', offer_id);
        if (!session || session.student_id !== parseInt(student_id) || session.payment_status !== 'paid') {
            return res.json({ can_join: false, error: 'لا يوجد حجز مدفوع' });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) return res.json({ can_join: false, status: 'not_found' });

        // ✅ إذا كان البث مباشراً ولديه رابط
        if (offer.status === 'live' && offer.stream_url) {
            // ✅ التحقق من أن الطالب مضاف إلى active_stream
            const { data: active } = await supabase
                .from('active_stream')
                .select('*')
                .eq('offer_id', offer_id)
                .eq('student_id', student_id)
                .single();

            // ✅ إذا لم يكن الطالب مضافاً، أضفه تلقائياً
            if (!active) {
                await insert('active_stream', { 
                    offer_id: parseInt(offer_id), 
                    student_id: parseInt(student_id),
                    joined_at: new Date().toISOString()
                });
                console.log(`✅ تم إضافة الطالب ${student_id} إلى active_stream تلقائياً`);
            }

            // ✅ تحديث الإشعار كمقروء
            await supabase
                .from('notifications')
                .update({ is_read: true })
                .eq('offer_id', offer_id)
                .eq('user_id', student_id);

            return res.json({ 
                can_join: true, 
                stream_url: offer.stream_url, 
                status: 'live',
                platform: offer.stream_platform || 'google-meet'
            });
        }

        // ✅ إذا كان البث في حالة "جاهز للبث"
        if (offer.status === 'teacher_ready') {
            const { data: existingWaiting } = await supabase
                .from('waiting_room')
                .select('*')
                .eq('offer_id', offer_id)
                .eq('student_id', student_id)
                .maybeSingle();

            if (!existingWaiting) {
                await insert('waiting_room', { offer_id: offer_id, student_id: student_id });
            }
            return res.json({ can_join: false, is_waiting: true, status: 'waiting' });
        }

        // ✅ إذا كان العرض قادماً
        if (offer.status === 'upcoming') {
            return res.json({ 
                can_join: false, 
                is_upcoming: true, 
                status: 'upcoming', 
                offer_date: offer.offer_date 
            });
        }

        return res.json({ can_join: false, status: 'unknown' });
    } catch (error) {
        console.error('خطأ في جلب حالة البث:', error.message);
        res.status(500).json({ can_join: false, status: 'error' });
    }
});

// ============================================================
// جلب المحفظة
// ============================================================
router.get('/wallet/:student_id', authenticate, authorize(['student']), [
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المعلومات' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) return res.status(404).json({ success: false, error: 'طالب غير موجود' });

        const { data: transactions } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('student_id', student_id)
            .order('created_at', { ascending: false })
            .limit(50);

        res.json({
            balance: student.wallet_balance || 0,
            transactions: transactions || []
        });
    } catch (error) {
        console.error('خطأ في جلب المحفظة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
