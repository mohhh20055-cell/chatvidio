const logger = require('../utils/logger');
// ============================================================
// مسارات المراسلات - Message Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');

const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert } = require('../utils/helpers');

// ذاكرة مؤقتة للحظر كاحتياط في حال عدم وجود جدول في قاعدة البيانات
const memoryBlocks = new Set(); // يخزن "teacherId-studentId"
// ذاكرة مؤقتة للتفاعلات
const memoryReactions = new Map(); // message_id -> [{ user_id, user_type, emoji }]
// ذاكرة مؤقتة للردود كاحتياط
const memoryReplies = new Map(); // message_id -> { reply_to_id, reply_to_text, reply_to_sender }

async function isBlocked(teacherId, studentId) {
    try {
        const { data, error } = await supabase
            .from('chat_blocks')
            .select('*')
            .eq('teacher_id', teacherId)
            .eq('student_id', studentId)
            .maybeSingle();

        if (error) {
            if (error.code === 'PGRST116' || error.message?.includes('relation "chat_blocks" does not exist')) {
                return memoryBlocks.has(`${teacherId}-${studentId}`);
            }
            throw error;
        }
        return !!data;
    } catch (e) {
        console.warn('⚠️ تنبيه: فشل التحقق من الحظر في قاعدة البيانات، استخدام الذاكرة المؤقتة:', e.message);
        return memoryBlocks.has(`${teacherId}-${studentId}`);
    }
}

async function addBlock(teacherId, studentId) {
    memoryBlocks.add(`${teacherId}-${studentId}`);
    try {
        const { error } = await supabase
            .from('chat_blocks')
            .insert({ teacher_id: teacherId, student_id: studentId });
        if (error && !error.message?.includes('relation "chat_blocks" does not exist')) {
            throw error;
        }
    } catch (e) {
        console.warn('⚠️ تنبيه: فشل حفظ الحظر في قاعدة البيانات:', e.message);
    }
}

async function removeBlock(teacherId, studentId) {
    memoryBlocks.delete(`${teacherId}-${studentId}`);
    try {
        const { error } = await supabase
            .from('chat_blocks')
            .delete()
            .eq('teacher_id', teacherId)
            .eq('student_id', studentId);
        if (error && !error.message?.includes('relation "chat_blocks" does not exist')) {
            throw error;
        }
    } catch (e) {
        console.warn('⚠️ تنبيه: فشل إلغاء الحظر من قاعدة البيانات:', e.message);
    }
}

// ============================================================
// ============================================================
// ✅ الحفاظ الدائم على سجل الرسائل والمحادثات
// ============================================================

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

        const { sender_id, sender_type, receiver_id, receiver_type, message, reply_to_id, reply_to_text, reply_to_sender } = req.body;

        if (req.user.userId !== sender_id || req.user.role !== sender_type) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإرسال رسائل من هذا الحساب' });
        }

        // تحقق من الحظر قبل إرسال الرسالة
        if (sender_type === 'student' && receiver_type === 'teacher') {
            const blocked = await isBlocked(receiver_id, sender_id);
            if (blocked) {
                return res.status(403).json({ success: false, error: 'لقد قام هذا الأستاذ بحظرك، لا يمكنك إرسال رسائل إليه.' });
            }
        } else if (sender_type === 'teacher' && receiver_type === 'student') {
            const blocked = await isBlocked(sender_id, receiver_id);
            if (blocked) {
                return res.status(403).json({ success: false, error: 'لقد قمت بحظر هذا الطالب، يرجى إلغاء الحظر أولاً لتتمكن من مراسلته.' });
            }
        }

        const msgPayload = {
            sender_id,
            sender_type,
            receiver_id,
            receiver_type,
            message: message.trim(),
            created_at: new Date().toISOString(),
            is_read: false
        };

        let newMessage;
        try {
            newMessage = await insert('messages', {
                ...msgPayload,
                ...(reply_to_id ? { reply_to_id: parseInt(reply_to_id, 10), reply_to_text: String(reply_to_text || '').slice(0, 300), reply_to_sender: String(reply_to_sender || '').slice(0, 100) } : {})
            });
        } catch(e) {
            // إذا كانت الأعمدة غير موجودة في Supabase، يتم الإدراج الأساسي والحفظ في الذاكرة
            newMessage = await insert('messages', msgPayload);
        }

        if (newMessage && reply_to_id) {
            memoryReplies.set(newMessage.id, {
                reply_to_id: parseInt(reply_to_id, 10),
                reply_to_text: String(reply_to_text || '').slice(0, 300),
                reply_to_sender: String(reply_to_sender || '').slice(0, 100)
            });
            newMessage.reply_to_id = parseInt(reply_to_id, 10);
            newMessage.reply_to_text = String(reply_to_text || '');
            newMessage.reply_to_sender = String(reply_to_sender || '');
        }

        res.json({ success: true, message: newMessage });
    } catch (error) {
        logger.error('خطأ في إرسال رسالة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب عدد الرسائل غير المقروءة (شارة تبويبة الرسائل)
// ============================================================
router.get('/unread-count/:user_id/:user_type', authenticate, [
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
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { count, error } = await supabase
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('receiver_id', userId)
            .eq('receiver_type', user_type)
            .eq('is_read', false);

        if (error) throw error;

        res.json({ success: true, unread_count: count || 0 });
    } catch (error) {
        logger.error('خطأ في جلب عدد الرسائل غير المقروءة:', error.message);
        res.json({ success: true, unread_count: 0 });
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
            return res.status(403).json({ success: false, error: 'غير مصرح لك بدرس هذه المحادثات' });
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
                let otherImage = null;
                if (otherType === 'teacher') {
                    const teacher = await getOne('teachers', 'id', otherId);
                    otherName = teacher?.full_name || 'أستاذ';
                    otherImage = teacher?.profile_image || teacher?.image_url || teacher?.avatar || null;
                } else {
                    const student = await getOne('students', 'id', otherId);
                    otherName = student?.full_name || 'طالب';
                    otherImage = student?.profile_image || student?.image_url || student?.avatar || null;
                }

                conversations[key] = {
                    other_id: otherId,
                    other_type: otherType,
                    other_name: otherName,
                    other_image: otherImage,
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
        logger.error('خطأ في جلب المحادثات:', error.message);
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
            return res.status(403).json({ success: false, error: 'غير مصرح لك بدرس هذه المحادثة' });
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

        const messagesList = data || [];

        // جلب تفاعلات الرسائل
        if (messagesList.length > 0) {
            const msgIds = messagesList.map(m => m.id);
            let reactionsByMsg = {};

            try {
                const { data: reactionsData } = await supabase
                    .from('message_reactions')
                    .select('*')
                    .in('message_id', msgIds);
                
                if (reactionsData) {
                    for (const r of reactionsData) {
                        if (!reactionsByMsg[r.message_id]) reactionsByMsg[r.message_id] = [];
                        reactionsByMsg[r.message_id].push(r);
                    }
                }
            } catch (e) {
                // تجاهل إذا كان الجدول غير موجود واستخدام الذاكرة
            }

            // دمج التفاعلات من الذاكرة كاحتياط
            for (const msgId of msgIds) {
                if (memoryReactions.has(msgId)) {
                    if (!reactionsByMsg[msgId]) reactionsByMsg[msgId] = [];
                    const memList = memoryReactions.get(msgId);
                    for (const mr of memList) {
                        if (!reactionsByMsg[msgId].some(x => x.user_id === mr.user_id && x.user_type === mr.user_type)) {
                            reactionsByMsg[msgId].push(mr);
                        }
                    }
                }
            }

            // تجميع التفاعلات لكل رسالة
            for (const msg of messagesList) {
                const rList = reactionsByMsg[msg.id] || [];
                const summaryMap = {};
                for (const r of rList) {
                    if (!summaryMap[r.emoji]) {
                        summaryMap[r.emoji] = { emoji: r.emoji, count: 0, user_reacted: false };
                    }
                    summaryMap[r.emoji].count++;
                    if (r.user_id === userId && r.user_type === user_type) {
                        summaryMap[r.emoji].user_reacted = true;
                    }
                }
                msg.reactions = Object.values(summaryMap);

                // إرفاق الردود
                if (memoryReplies.has(msg.id)) {
                    const rep = memoryReplies.get(msg.id);
                    msg.reply_to_id = msg.reply_to_id || rep.reply_to_id;
                    msg.reply_to_text = msg.reply_to_text || rep.reply_to_text;
                    msg.reply_to_sender = msg.reply_to_sender || rep.reply_to_sender;
                }
            }
        }

        res.json(messagesList);
    } catch (error) {
        logger.error('خطأ في جلب المحادثة:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// التفاعل مع الرسائل (إضافة/تعديل/حذف إيموجي)
// ============================================================
router.post('/react', authenticate, [
    body('message_id').isInt().withMessage('معرف الرسالة غير صالح'),
    body('emoji').notEmpty().withMessage('الإيموجي مطلوب').isLength({ max: 10 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const message_id = parseInt(req.body.message_id, 10);
        const emoji = req.body.emoji.trim();
        const user_id = req.user.userId;
        const user_type = req.user.role;

        let currentEmoji = null;

        // 1. المحاولة في قاعدة البيانات Supabase
        try {
            const { data: existing, error: fetchErr } = await supabase
                .from('message_reactions')
                .select('*')
                .eq('message_id', message_id)
                .eq('user_id', user_id)
                .eq('user_type', user_type)
                .maybeSingle();

            if (!fetchErr) {
                if (existing) {
                    if (existing.emoji === emoji) {
                        await supabase
                            .from('message_reactions')
                            .delete()
                            .eq('id', existing.id);
                        currentEmoji = null;
                    } else {
                        await supabase
                            .from('message_reactions')
                            .update({ emoji })
                            .eq('id', existing.id);
                        currentEmoji = emoji;
                    }
                } else {
                    await supabase
                        .from('message_reactions')
                        .insert({ message_id, user_id, user_type, emoji });
                    currentEmoji = emoji;
                }
            }
        } catch (e) {
            console.warn('⚠️ تنبيه: فشل الحفظ في جدول message_reactions:', e.message);
        }

        // 2. تحديث الذاكرة المؤقتة دائما كاحتياط
        if (!memoryReactions.has(message_id)) {
            memoryReactions.set(message_id, []);
        }
        let list = memoryReactions.get(message_id);
        const idx = list.findIndex(r => r.user_id === user_id && r.user_type === user_type);
        if (idx !== -1) {
            if (list[idx].emoji === emoji) {
                list.splice(idx, 1);
            } else {
                list[idx].emoji = emoji;
            }
        } else {
            list.push({ user_id, user_type, emoji });
        }

        res.json({ success: true, emoji: currentEmoji });
    } catch (error) {
        logger.error('خطأ في التفاعل مع الرسالة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// حظر طالب
// ============================================================
router.post('/block', authenticate, [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ success: false, error: 'هذا الإجراء متاح للأساتذة فقط' });
        }
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = req.user.userId;
        const studentId = parseInt(req.body.student_id);

        await addBlock(teacherId, studentId);
        res.json({ success: true, message: 'تم حظر الطالب بنجاح' });
    } catch (error) {
        logger.error('خطأ في حظر الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إلغاء حظر طالب
// ============================================================
router.post('/unblock', authenticate, [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ success: false, error: 'هذا الإجراء متاح للأساتذة فقط' });
        }
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = req.user.userId;
        const studentId = parseInt(req.body.student_id);

        await removeBlock(teacherId, studentId);
        res.json({ success: true, message: 'تم إلغاء حظر الطالب بنجاح' });
    } catch (error) {
        logger.error('خطأ في إلغاء حظر الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب قائمة الطلاب المحظورين
// ============================================================
router.get('/blocked-students', authenticate, async (req, res) => {
    try {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ success: false, error: 'هذا الإجراء متاح للأساتذة فقط' });
        }
        const teacherId = req.user.userId;

        let blockedIds = new Set();
        try {
            const { data, error } = await supabase
                .from('chat_blocks')
                .select('student_id')
                .eq('teacher_id', teacherId);
            
            if (data) {
                data.forEach(row => blockedIds.add(row.student_id));
            }
        } catch (e) {
            console.warn('Failed to fetch blocks from db:', e.message);
        }

        // إضافة من الذاكرة المؤقتة كاحتياط
        for (const key of memoryBlocks) {
            const [tId, sId] = key.split('-');
            if (parseInt(tId) === teacherId) {
                blockedIds.add(parseInt(sId));
            }
        }

        res.json({ success: true, blocked_ids: Array.from(blockedIds) });
    } catch (error) {
        logger.error('خطأ في جلب قائمة المحظورين:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
