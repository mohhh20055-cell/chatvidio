// ============================================================
// مسارات الإدارة - Admin Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');

// استيراد الدوال - ✅ لا نستورد authorize من middleware
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
// جلب جميع الطلاب
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
// جلب جميع الأساتذة المعلقين
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
// جلب جميع الأساتذة المقبولين
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
// قبول الأستاذ
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

        await update('teachers', teacherId, { status: 'approved' });

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

        res.json({ success: true, message: 'تم قبول الأستاذ ومنح مكافأة الإحالة إن وجدت' });
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
// حذف المستخدم (طالب أو أستاذ)
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
            .
