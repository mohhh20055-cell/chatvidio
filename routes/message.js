// ============================================================
// مسارات المراسلات - Message Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');

const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert } = require('../utils/helpers');

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
// إرسال رسالة
// ============================================================
router.post('/send', authenticate, [
    body('sender_id').isInt().withMessage('معرف المرسل غير صالح'),
    body('sender_type').isIn(['student', 'teacher']).withMessage('نوع المرسل غير صالح'),
    body('receiver_id').isInt().withMessage('معرف المستقبل غير صالح'),
    body('receiver_type').isIn(['student', 'teacher']).withMessage('نوع المستقبل غير صالح'),
    body('message').notEmpty().withMessage('الرسالة مطلوبة').isLength({ max: 2000 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { sender_id, sender_type, receiver_id, receiver_type, message } = req.body;

        if (req.user.userId !== sender_id || req.user.role !== sender_type) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإرسال رسائل من هذا الحساب' });
        }

        const newMessage = await insert('messages', {
            sender_id,
            sender_type,
            receiver_id,
            receiver_type,
            message: message.trim(),
            created_at: new Date().toISOString(),
            is_read: false
        });

        await insert('notifications', {
            user_id: receiver_id,
            user_type: receiver_type,
            title: 'رسالة جديدة',
            message: 'لديك رسالة جديدة',
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ success: true, message: newMessage });
    } catch (error) {
        console.error('خطأ في إرسال رسالة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب المحادثات
// ============================================================
router.get('/conversations/:user_id/:user_type', authenticate, [
    param('user_id').isInt().withMessage('معرف المستخدم غير صالح'),
    param('user_type').isIn(['student', 'teacher']).withMessage('نوع المستخدم غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const userId = parseInt(req.params.user_id);
        const { user_type } = req.params;

        if (req.user.userId !== userId || req.user.role !== user_type) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المحادثات' });
        }

        const { data } = await supabase
            .from('messages')
            .select('*')
            .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
            .order('created_at', { ascending: false });

        const conversations = {};
        for (const msg of data || []) {
            const otherId = msg.sender_id == userId ? msg.receiver_id : msg.sender_id;
            const otherType = msg.sender_id == userId ? msg.receiver_type : msg.sender_type;
            const key = `${otherId}-${otherType}`;

            if (!conversations[key] || msg.created_at > conversations[key].last_message_date) {
                let otherName = 'مستخدم';
                if (otherType === 'teacher') {
                    const teacher = await getOne('teachers', 'id', otherId);
                    otherName = teacher?.full_name || 'أستاذ';
                } else {
                    const student = await getOne('students', 'id', otherId);
                    otherName = student?.full_name || 'طالب';
                }

                conversations[key] = {
                    other_id: otherId,
                    other_type: otherType,
                    other_name: otherName,
                    other_image: null,
                    last_message: msg.message,
                    last_message_date: msg.created_at,
                    unread_count: (!msg.is_read && msg.receiver_id == userId) ? 1 : 0
                };
            } else if (!msg.is_read && msg.receiver_id == userId) {
                conversations[key].unread_count++;
            }
        }

        res.json(Object.values(conversations));
    } catch (error) {
        console.error('خطأ في جلب المحادثات:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب محادثة محددة
// ============================================================
router.get('/:user_id/:user_type/:other_id/:other_type', authenticate, [
    param('user_id').isInt().withMessage('معرف المستخدم غير صالح'),
    param('user_type').isIn(['student', 'teacher']).withMessage('نوع المستخدم غير صالح'),
    param('other_id').isInt().withMessage('معرف الطرف الآخر غير صالح'),
    param('other_type').isIn(['student', 'teacher']).withMessage('نوع الطرف الآخر غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const userId = parseInt(req.params.user_id);
        const otherId = parseInt(req.params.other_id);
        const { user_type } = req.params;

        if (req.user.userId !== userId || req.user.role !== user_type) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المحادثة' });
        }

        const { data } = await supabase
            .from('messages')
            .select('*')
            .or(`and(sender_id.eq.${userId},receiver_id.eq.${otherId}),and(sender_id.eq.${otherId},receiver_id.eq.${userId})`)
            .order('created_at', { ascending: true });

        await supabase
            .from('messages')
            .update({ is_read: true })
            .eq('receiver_id', userId)
            .eq('sender_id', otherId);

        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب المحادثة:', error.message);
        res.status(500).json([]);
    }
});

module.exports = router;
