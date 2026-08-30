const logger = require('../utils/logger');
// ============================================================
// مسارات الإشعارات - Notification Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { param, validationResult } = require('express-validator');

const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { update } = require('../utils/helpers');

// ✅ تعريف authorize محلياً (ليس مستخدم هنا لكن للتوحيد)
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
// جلب الإشعارات
// ============================================================
router.get('/:user_id/:user_type', authenticate, [
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
            return res.status(403).json({ success: false, error: 'غير مصرح لك بدرس هذه الإشعارات' });
        }

        const { data } = await supabase
            .from('notifications')
            .select('*')
            .eq('user_id', parseInt(user_id))
            .eq('user_type', user_type)
            .order('created_at', { ascending: false })
            .limit(50);

        res.json(data || []);
    } catch (error) {
        logger.error('خطأ في جلب الإشعارات:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// قراءة إشعار
// ============================================================
router.post('/read/:notification_id', authenticate, [
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
        logger.error('خطأ في تحديث الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// مسح جميع الإشعارات للمستخدم
// ============================================================
router.delete('/delete-all', authenticate, async (req, res) => {
    try {
        const userId = req.user?.userId || req.user?.id;
        const userRole = req.user?.role || req.user?.userType;

        let query = supabase.from('notifications').delete();
        
        // إذا لم يكن أدمن، امسح إشعاراته فقط
        if (userRole !== 'admin') {
            if (!userId) {
                return res.status(400).json({ success: false, error: 'معرف المستخدم غير متاح' });
            }
            query = query.or(`user_id.eq.${userId},user_id.is.null`);
        }

        const { data, error } = await query;

        if (error) {
            console.error('[NOTIFICATIONS DELETE ALL] Error:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`[NOTIFICATIONS DELETE ALL] Successfully deleted notifications for user ${userId}`);
        res.json({ success: true, message: 'تم مسح جميع الإشعارات بنجاح' });
    } catch (err) {
        console.error('[NOTIFICATIONS DELETE ALL] Exception:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
