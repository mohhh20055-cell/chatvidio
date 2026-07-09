// ============================================================
// مسارات الإدارة - Admin Routes (معدل لدعم المستوى التعليمي)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');

// استيراد الدوال
const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');
const { encrypt, maskIP } = require('../utils/encryption');
const { processReferralReward } = require('../utils/referral');

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

// الثوابت
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@platform.com';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('admin123', 12);

// ============================================================
// جلب جميع الطلاب (مع المستوى التعليمي)
// ============================================================
router.get('/students', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('students')
            .select('*')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب الطلاب:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب جميع الأساتذة المعلقين (مع المستوى التعليمي)
// ============================================================
router.get('/pending-teachers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('teachers')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب الأساتذة المعلقين:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب جميع الأساتذة المقبولين (مع المستوى التعليمي)
// ============================================================
router.get('/approved-teachers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('teachers')
            .select('*')
            .eq('status', 'approved')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب الأساتذة المقبولين:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// قبول الأستاذ (يحتفظ بالمستوى التعليمي)
// ============================================================
router.post('/approve-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = req.params.id;

        // ✅ جلب بيانات الأستاذ للتحقق من وجود teaching_level
        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        // ✅ تحديث الحالة مع الاحتفاظ بـ teaching_level
        await update('teachers', teacherId, { 
            status: 'approved',
            // الاحتفاظ بـ teaching_level إذا كان موجوداً
            teaching_level: teacher.teaching_level || null
        });

        // ✅ معالجة مكافأة الإحالة
        const { data: referral } = await supabase
            .from('referrals')
            .select('*')
            .eq('referred_user_id', teacherId)
            .eq('referred_user_role', 'teacher')
            .eq('status', 'pending_verification')
            .single();

        if (referral) {
            await processReferralReward(teacherId, 'teacher');
            console.log(`✅ تم منح مكافأة الإحالة للأستاذ المحيل فور قبول الأستاذ ${teacherId}`);
        }

        res.json({ 
            success: true, 
            message: 'تم قبول الأستاذ ومنح مكافأة الإحالة إن وجدت',
            teaching_level: teacher.teaching_level || null
        });
    } catch (error) {
        console.error('خطأ في قبول الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// رفض الأستاذ
// ============================================================
router.post('/reject-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { reason } = req.body;
        await update('teachers', req.params.id, {
            status: 'rejected',
            rejection_reason: reason || 'لم يتم تحديد سبب'
        });
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في رفض الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// حذف الأستاذ
// ============================================================
router.delete('/delete-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = req.params.id;

        const teacher = await getOne('teachers', 'id', teacherId);
        if (teacher?.profile_image) {
            await supabase.storage.from('profiles').remove([`teachers/${teacher.profile_image}`]);
        }

        await supabase.from('sessions').delete().eq('teacher_id', teacherId);
        await supabase.from('waiting_room').delete().eq('teacher_id', teacherId);
        await supabase.from('active_stream').delete().eq('teacher_id', teacherId);
        await supabase.from('offers').delete().eq('teacher_id', teacherId);
        await supabase.from('withdraw_requests').delete().eq('teacher_id', teacherId);
        await supabase.from('notifications').delete().eq('user_id', teacherId).eq('user_type', 'teacher');
        await supabase.from('teachers').delete().eq('id', teacherId);

        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في حذف الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// حذف المستخدم (طالب أو أستاذ) - مع دعم المستوى التعليمي
// ============================================================
router.post('/delete-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role, ban } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }
        
        const { data: loginLog } = await supabase
            .from('login_logs')
            .select('ip_address_encrypted')
            .eq('user_id', user_id)
            .eq('user_role', role)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
        
        const userIp = loginLog?.ip_address_encrypted || null;
        
        await supabase
            .from(tableName)
            .delete()
            .eq('id', user_id);
        
        if (ban && userIp) {
            const { data: existingBan } = await supabase
                .from('banned_users')
                .select('*')
                .eq('ip_address_encrypted', userIp)
                .single();
            
            if (!existingBan) {
                await insert('banned_users', {
                    user_id: user_id,
                    user_role: role,
                    full_name: user.full_name,
                    email: user.email,
                    ip_address_encrypted: userIp,
                    ban_reason: 'تم حظر المستخدم تلقائياً عند حذف الحساب',
                    banned_at: new Date().toISOString(),
                    banned_by: 'admin'
                });
            }
        }
        
        res.json({ 
            success: true, 
            message: 'تم حذف المستخدم بنجاح',
            banned: ban && userIp ? true : false
        });
    } catch (error) {
        console.error('خطأ في حذف المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// حظر المستخدم
// ============================================================
router.post('/ban-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role, reason } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }
        
        const { data: loginLog } = await supabase
            .from('login_logs')
            .select('ip_address_encrypted')
            .eq('user_id', user_id)
            .eq('user_role', role)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
        
        const userIp = loginLog?.ip_address_encrypted || null;
        
        if (!userIp) {
            return res.status(400).json({ success: false, error: 'لا يمكن تحديد IP المستخدم' });
        }
        
        const { data: existingBan } = await supabase
            .from('banned_users')
            .select('*')
            .eq('ip_address_encrypted', userIp)
            .single();
        
        if (existingBan) {
            return res.status(400).json({ success: false, error: 'هذا المستخدم محظور بالفعل' });
        }
        
        await insert('banned_users', {
            user_id: user_id,
            user_role: role,
            full_name: user.full_name,
            email: user.email,
            ip_address_encrypted: userIp,
            ban_reason: reason || 'لم يتم تحديد سبب',
            banned_at: new Date().toISOString(),
            banned_by: 'admin'
        });
        
        await supabase
            .from(tableName)
            .update({ is_banned: true, ban_reason: reason || 'لم يتم تحديد سبب' })
            .eq('id', user_id);
        
        res.json({ success: true, message: 'تم حظر المستخدم بنجاح' });
    } catch (error) {
        console.error('خطأ في حظر المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إلغاء حظر المستخدم
// ============================================================
router.post('/unban-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        const { data: banRecord } = await supabase
            .from('banned_users')
            .select('*')
            .eq('user_id', user_id)
            .eq('user_role', role)
            .single();
        
        if (!banRecord) {
            return res.status(404).json({ success: false, error: 'المستخدم غير محظور' });
        }
        
        await supabase
            .from('banned_users')
            .delete()
            .eq('id', banRecord.id);
        
        await supabase
            .from(tableName)
            .update({ is_banned: false, ban_reason: null })
            .eq('id', user_id);
        
        res.json({ success: true, message: 'تم إلغاء حظر المستخدم بنجاح' });
    } catch (error) {
        console.error('خطأ في إلغاء الحظر:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب المستخدمين المحظورين
// ============================================================
router.get('/banned-users', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('banned_users')
            .select('*')
            .order('banned_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب المحظورين:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// طلبات السحب
// ============================================================
router.get('/withdraw-requests', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('withdraw_requests')
            .select('*, teachers:teacher_id (full_name, email, phone)')
            .eq('status', 'pending')
            .order('created_at', { ascending: true });
        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب طلبات السحب:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// قبول طلب سحب
// ============================================================
router.post('/withdraw-requests/:id/approve', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الطلب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { id } = req.params;

        const request = await getOne('withdraw_requests', 'id', id);
        if (!request) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });

        await update('withdraw_requests', id, {
            status: 'completed',
            processed_at: new Date().toISOString()
        });

        const teacher = await getOne('teachers', 'id', request.teacher_id);
        await update('teachers', request.teacher_id, {
            total_withdrawn: (teacher.total_withdrawn || 0) + request.amount,
            pending_withdraw: (teacher.pending_withdraw || 0) - request.amount
        });

        await insert('notifications', {
            user_id: request.teacher_id,
            user_type: 'teacher',
            title: 'تمت معالجة طلب السحب',
            message: `تم تحويل مبلغ ${request.amount} دج إلى حسابك ${request.ccp_account}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في قبول طلب سحب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// رفض طلب سحب
// ============================================================
router.post('/withdraw-requests/:id/reject', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الطلب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { id } = req.params;
        const { reason } = req.body;

        const request = await getOne('withdraw_requests', 'id', id);
        if (!request) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });

        await update('withdraw_requests', id, {
            status: 'rejected',
            rejection_reason: reason || 'لم يتم تحديد سبب',
            processed_at: new Date().toISOString()
        });

        const teacher = await getOne('teachers', 'id', request.teacher_id);
        await update('teachers', request.teacher_id, {
            balance: (teacher.balance || 0) + request.amount,
            pending_withdraw: (teacher.pending_withdraw || 0) - request.amount
        });

        await insert('notifications', {
            user_id: request.teacher_id,
            user_type: 'teacher',
            title: 'تم رفض طلب السحب',
            message: `تم رفض طلب سحب مبلغ ${request.amount} دج. السبب: ${reason || 'لم يتم تحديد سبب'}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في رفض طلب سحب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إرسال إشعار لجميع الطلاب
// ============================================================
router.post('/send-notification-to-all-students', [
    authenticate,
    authorize(['admin']),
    body('title').notEmpty().withMessage('العنوان مطلوب').isLength({ max: 100 }),
    body('message').notEmpty().withMessage('المحتوى مطلوب').isLength({ max: 500 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { title, message } = req.body;

        const { data: students } = await supabase
            .from('students')
            .select('id')
            .eq('email_verified', true);

        if (!students || students.length === 0) {
            return res.status(404).json({ success: false, error: 'لا يوجد طلاب مسجلين' });
        }

        const notifications = students.map(s => ({
            user_id: s.id,
            user_type: 'student',
            title: title.trim(),
            message: message.trim(),
            is_read: false,
            created_at: new Date().toISOString()
        }));

        const { error } = await supabase
            .from('notifications')
            .insert(notifications);

        if (error) {
            console.error('خطأ في إرسال الإشعارات:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        await supabase
            .from('admin_notifications')
            .insert({
                title: title.trim(),
                message: message.trim(),
                sent_to_all: true,
                students_count: students.length,
                created_at: new Date().toISOString()
            });

        res.json({
            success: true,
            students_count: students.length,
            message: `تم إرسال الإشعار إلى ${students.length} طالب`
        });
    } catch (error) {
        console.error('خطأ في إرسال الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب الإشعارات المرسلة
// ============================================================
router.get('/sent-notifications', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('admin_notifications')
            .select('*')
            .order('created_at', { ascending: false });

        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب الإشعارات المرسلة:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// حذف إشعار
// ============================================================
router.delete('/delete-notification/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الإشعار غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        await supabase
            .from('admin_notifications')
            .delete()
            .eq('id', req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في حذف الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// مراقبة الأداء
// ============================================================
router.get('/performance', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data: connections } = await supabase
            .from('active_stream')
            .select('count', { count: 'exact' });

        const { data: sessions } = await supabase
            .from('sessions')
            .select('count', { count: 'exact' });

        const memoryUsage = process.memoryUsage();
        const uptime = process.uptime();

        res.json({
            status: 'healthy',
            uptime: Math.floor(uptime),
            memory: {
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
                rss: Math.round(memoryUsage.rss / 1024 / 1024)
            },
            active_streams: connections?.count || 0,
            total_sessions: sessions?.count || 0
        });
    } catch (error) {
        console.error('خطأ في مراقبة الأداء:', error.message);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// ============================================================
// رسائل الدعم
// ============================================================
router.get('/support-messages', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = await supabase
            .from('support_messages')
            .select('*')
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب رسائل الدعم:', error.message);
        res.status(500).json([]);
    }
});

router.put('/support-messages/:id/read', [
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
        console.error('خطأ في تحديث رسالة الدعم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

router.delete('/support-messages/:id', [
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
        console.error('خطأ في حذف رسالة الدعم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
