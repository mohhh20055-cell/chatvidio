// ============================================================
// مسارات الدعم الفني
// ============================================================

const express = require('express');
const router = express.Router();
const { body, validationResult, param } = require('express-validator');

// استيراد الدوال المساعدة
const { 
    authenticate, 
    authorize, 
    insert, 
    update, 
    remove,
    supabase,
    sanitizeInput
} = require('../server');

// ============================================================
// إرسال رسالة دعم
// ============================================================
router.post('/support/send', [
    body('name').notEmpty().withMessage('الاسم مطلوب').isLength({ max: 100 }),
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح').trim().normalizeEmail(),
    body('subject').notEmpty().withMessage('الموضوع مطلوب').isLength({ max: 200 }),
    body('message').notEmpty().withMessage('الرسالة مطلوبة').isLength({ max: 2000 })
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

        res.json({ success: true, message: 'تم إرسال رسالتك بنجاح' });
    } catch (error) {
        console.error('خطأ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب رسائل الدعم (للمدير)
// ============================================================
router.get('/admin/support-messages', [
    authenticate,
    authorize(['admin'])
], async (req, res) => {
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

// ============================================================
// تحديد رسالة دعم كمقروءة
// ============================================================
router.put('/admin/support-messages/:id/read', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الرسالة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        await update('support_messages', req.params.id, { status: 'read' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// حذف رسالة دعم
// ============================================================
router.delete('/admin/support-messages/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الرسالة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        await remove('support_messages', 'id', req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;