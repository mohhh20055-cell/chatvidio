// ============================================================
// مسارات الإشعارات
// ============================================================

const express = require('express');
const router = express.Router();
const { param, validationResult } = require('express-validator');

// استيراد الدوال المساعدة من الملف الرئيسي
const server = require('../server');

// استخراج الدوال من server
const { 
    authenticate, 
    update, 
    supabase
} = server;

// ============================================================
// جلب الإشعارات
// ============================================================
router.get('/notifications/:user_id/:user_type', [
    authenticate,
    param('user_id').isInt().withMessage('معرف المستخدم غير صالح'),
    param('user_type').isIn(['student', 'teacher']).withMessage('نوع المستخدم غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, user_type } = req.params;

        if (req.user.userId !== parseInt(user_id) || req.user.role !== user_type) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه الإشعارات' });
        }

        const { data } = await supabase
            .from('notifications')
            .select('*')
            .eq('user_id', user_id)
            .eq('user_type', user_type)
            .order('created_at', { ascending: false })
            .limit(50);

        res.json(data || []);
    } catch (error) {
        res.status(500).json([]);
    }
});

// ============================================================
// تحديد إشعار كمقروء
// ============================================================
router.post('/notifications/read/:notification_id', [
    authenticate,
    param('notification_id').isInt().withMessage('معرف الإشعار غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const notification_id = parseInt(req.params.notification_id);

        const { data: notification } = await supabase
            .from('notifications')
            .select('user_id, user_type')
            .eq('id', notification_id)
            .single();

        if (notification && (notification.user_id !== req.user.userId || notification.user_type !== req.user.role)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        await update('notifications', notification_id, { is_read: true });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
