// ============================================================
// مسارات الدعم - Support Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');

const { insert } = require('../utils/helpers');

// ============================================================
// إرسال رسالة دعم
// ============================================================
router.post('/send', [
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

        console.log(`📩 رسالة دعم جديدة من ${name} (${email})`);
        res.json({ success: true, message: 'تم إرسال رسالتك بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في إرسال رسالة الدعم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
