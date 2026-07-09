// ============================================================
// مسارات الإدارة - Admin Routes (معدل لدعم المستوى التعليمي مع معالجة أفضل للأخطاء)
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
// ✅ جلب جميع الطلاب (مع المستوى التعليمي) - مع معالجة الأخطاء
// ============================================================
router.get('/students', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب جميع الطلاب...');
        
        const { data, error } = await supabase
            .from('students')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب الطلاب:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} طالب`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب الطلاب:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع الأساتذة المعلقين (مع المستوى التعليمي)
// ============================================================
router.get('/pending-teachers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب الأساتذة المعلقين...');
        
        const { data, error } = await supabase
            .from('teachers')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب الأساتذة المعلقين:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} أستاذ معلق`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب الأساتذة المعلقين:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع الأساتذة المقبولين (مع المستوى التعليمي)
// ============================================================
router.get('/approved-teachers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب الأساتذة المقبولين...');
        
        const { data, error } = await supabase
            .from('teachers')
            .select('*')
            .eq('status', 'approved')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب الأساتذة المقبولين:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} أستاذ مقبول`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب الأساتذة المقبولين:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ قبول الأستاذ (يحتفظ بالمستوى التعليمي)
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

        const teacherId = parseInt(req.params.id);
        console.log(`📥 قبول الأستاذ ID: ${teacherId}`);

        // ✅ جلب بيانات الأستاذ
        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        console.log(`👤 الأستاذ: ${teacher.full_name}, المستوى: ${teacher.teaching_level || 'غير محدد'}`);

        // ✅ تحديث الحالة مع الاحتفاظ بـ teaching_level
        const { error: updateError } = await supabase
            .from('teachers')
            .update({ 
                status: 'approved',
                teaching_level: teacher.teaching_level || null
            })
            .eq('id', teacherId);

        if (updateError) {
            console.error('❌ خطأ في تحديث حالة الأستاذ:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        // ✅ معالجة مكافأة الإحالة
        try {
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
        } catch (referralError) {
            console.warn('⚠️ خطأ في معالجة مكافأة الإحالة:', referralError.message);
        }

        console.log(`✅ تم قبول الأستاذ ${teacherId} بنجاح`);
        res.json({ 
            success: true, 
            message: 'تم قبول الأستاذ ومنح مكافأة الإحالة إن وجدت',
            teaching_level: teacher.teaching_level || null
        });
    } catch (error) {
        console.error('❌ خطأ في قبول الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ رفض الأستاذ
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

        const teacherId = parseInt(req.params.id);
        const { reason } = req.body;

        console.log(`📥 رفض الأستاذ ID: ${teacherId}, السبب: ${reason || 'غير محدد'}`);

        const { error } = await supabase
            .from('teachers')
            .update({
                status: 'rejected',
                rejection_reason: reason || 'لم يتم تحديد سبب'
            })
            .eq('id', teacherId);

        if (error) {
            console.error('❌ خطأ في رفض الأستاذ:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم رفض الأستاذ ${teacherId}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في رفض الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ حذف الأستاذ
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

        const teacherId = parseInt(req.params.id);
        console.log(`📥 حذف الأستاذ ID: ${teacherId}`);

        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        // حذف الصورة إذا وجدت
        if (teacher?.profile_image) {
            try {
                await supabase.storage.from('profiles').remove([`teachers/${teacher.profile_image}`]);
            } catch (storageError) {
                console.warn('⚠️ خطأ في حذف الصورة:', storageError.message);
            }
        }

        // حذف البيانات المرتبطة
        const tables = ['sessions', 'waiting_room', 'active_stream', 'offers', 'withdraw_requests'];
        for (const table of tables) {
            try {
                await supabase.from(table).delete().eq('teacher_id', teacherId);
            } catch (e) {
                console.warn(`⚠️ خطأ في حذف بيانات ${table}:`, e.message);
            }
        }

        // حذف الإشعارات
        await supabase.from('notifications').delete().eq('user_id', teacherId).eq('user_type', 'teacher');

        // حذف الأستاذ
        const { error } = await supabase.from('teachers').delete().eq('id', teacherId);

        if (error) {
            console.error('❌ خطأ في حذف الأستاذ:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم حذف الأستاذ ${teacherId}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في حذف الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ حذف المستخدم (طالب أو أستاذ)
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
        
        console.log(`📥 حذف المستخدم ID: ${user_id}, الدور: ${role}, حظر: ${ban}`);

        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }
        
        // جلب IP المستخدم
        let userIp = null;
        try {
            const { data: loginLog } = await supabase
                .from('login_logs')
                .select('ip_address_encrypted')
                .eq('user_id', user_id)
                .eq('user_role', role)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            
            userIp = loginLog?.ip_address_encrypted || null;
        } catch (logError) {
            console.warn('⚠️ لا يوجد سجل دخول لهذا المستخدم:', logError.message);
        }
        
        // حذف المستخدم
        const { error } = await supabase
            .from(tableName)
            .delete()
            .eq('id', user_id);

        if (error) {
            console.error('❌ خطأ في حذف المستخدم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
        
        // حظر IP إذا تم الطلب
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
                console.log(`🔒 تم حظر IP المستخدم ${user_id}`);
            }
        }
        
        console.log(`✅ تم حذف المستخدم ${user_id}`);
        res.json({ 
            success: true, 
            message: 'تم حذف المستخدم بنجاح',
            banned: ban && userIp ? true : false
        });
    } catch (error) {
        console.error('❌ خطأ في حذف المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ حظر المستخدم - معدل للتعامل مع حالة عدم وجود IP
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
        
        console.log(`📥 حظر المستخدم ID: ${user_id}, الدور: ${role}`);

        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }
        
        // ✅ محاولة جلب IP المستخدم
        let userIp = null;
        try {
            const { data: loginLog } = await supabase
                .from('login_logs')
                .select('ip_address_encrypted')
                .eq('user_id', user_id)
                .eq('user_role', role)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            
            userIp = loginLog?.ip_address_encrypted || null;
        } catch (logError) {
            console.warn('⚠️ لا يوجد سجل دخول لهذا المستخدم:', logError.message);
        }
        
        // ✅ إذا لم يوجد IP، نستخدم معرف المستخدم كمعرف فريد للحظر
        if (!userIp) {
            console.log(`⚠️ لا يمكن تحديد IP للمستخدم ${user_id}, سيتم استخدام معرف المستخدم للحظر`);
            // إنشاء معرف فريد للمستخدم
            userIp = `user_${user_id}_${role}_${Date.now()}`;
        }
        
        // ✅ التحقق من عدم وجود حظر سابق
        const { data: existingBan } = await supabase
            .from('banned_users')
            .select('*')
            .eq('ip_address_encrypted', userIp)
            .single();
        
        if (existingBan) {
            // ✅ إذا كان محظوراً بالفعل، قم بتحديث السبب والتاريخ
            await supabase
                .from('banned_users')
                .update({
                    ban_reason: reason || 'تم تحديث سبب الحظر',
                    banned_at: new Date().toISOString(),
                    banned_by: 'admin'
                })
                .eq('id', existingBan.id);
            
            // ✅ تحديث حالة المستخدم في جدول الطلاب/الأساتذة
            await supabase
                .from(tableName)
                .update({ is_banned: true, ban_reason: reason || 'لم يتم تحديد سبب' })
                .eq('id', user_id);
            
            console.log(`🔒 تم تحديث حظر المستخدم ${user_id}`);
            return res.json({ success: true, message: 'تم تحديث حظر المستخدم بنجاح' });
        }
        
        // ✅ إنشاء سجل حظر جديد
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
        
        // ✅ تحديث حالة المستخدم
        const { error } = await supabase
            .from(tableName)
            .update({ is_banned: true, ban_reason: reason || 'لم يتم تحديد سبب' })
            .eq('id', user_id);

        if (error) {
            console.error('❌ خطأ في حظر المستخدم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
        
        console.log(`🔒 تم حظر المستخدم ${user_id}`);
        res.json({ success: true, message: 'تم حظر المستخدم بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في حظر المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إلغاء حظر المستخدم
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
        
        console.log(`📥 إلغاء حظر المستخدم ID: ${user_id}, الدور: ${role}`);
        
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
        
        const { error } = await supabase
            .from(tableName)
            .update({ is_banned: false, ban_reason: null })
            .eq('id', user_id);

        if (error) {
            console.error('❌ خطأ في إلغاء حظر المستخدم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
        
        console.log(`✅ تم إلغاء حظر المستخدم ${user_id}`);
        res.json({ success: true, message: 'تم إلغاء حظر المستخدم بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في إلغاء الحظر:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب المستخدمين المحظورين
// ============================================================
router.get('/banned-users', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب المستخدمين المحظورين...');
        
        const { data, error } = await supabase
            .from('banned_users')
            .select('*')
            .order('banned_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب المحظورين:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} مستخدم محظور`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب المحظورين:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ طلبات السحب
// ============================================================
router.get('/withdraw-requests', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب طلبات السحب...');
        
        const { data, error } = await supabase
            .from('withdraw_requests')
            .select('*, teachers:teacher_id (full_name, email, phone)')
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error) {
            console.error('❌ خطأ في جلب طلبات السحب:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} طلب سحب`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب طلبات السحب:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ قبول طلب سحب
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
        console.log(`📥 قبول طلب سحب ID: ${id}`);

        const request = await getOne('withdraw_requests', 'id', id);
        if (!request) {
            return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
        }

        // تحديث حالة الطلب
        const { error: updateError } = await supabase
            .from('withdraw_requests')
            .update({
                status: 'completed',
                processed_at: new Date().toISOString()
            })
            .eq('id', id);

        if (updateError) {
            console.error('❌ خطأ في تحديث طلب السحب:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        // تحديث رصيد الأستاذ
        const teacher = await getOne('teachers', 'id', request.teacher_id);
        if (teacher) {
            await supabase
                .from('teachers')
                .update({
                    total_withdrawn: (teacher.total_withdrawn || 0) + request.amount,
                    pending_withdraw: (teacher.pending_withdraw || 0) - request.amount
                })
                .eq('id', request.teacher_id);
        }

        // إرسال إشعار للأستاذ
        await insert('notifications', {
            user_id: request.teacher_id,
            user_type: 'teacher',
            title: 'تمت معالجة طلب السحب',
            message: `تم تحويل مبلغ ${request.amount} دج إلى حسابك ${request.ccp_account}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        console.log(`✅ تم قبول طلب السحب ${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في قبول طلب سحب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ رفض طلب سحب
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
        
        console.log(`📥 رفض طلب سحب ID: ${id}, السبب: ${reason || 'غير محدد'}`);

        const request = await getOne('withdraw_requests', 'id', id);
        if (!request) {
            return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
        }

        // تحديث حالة الطلب
        const { error: updateError } = await supabase
            .from('withdraw_requests')
            .update({
                status: 'rejected',
                rejection_reason: reason || 'لم يتم تحديد سبب',
                processed_at: new Date().toISOString()
            })
            .eq('id', id);

        if (updateError) {
            console.error('❌ خطأ في تحديث طلب السحب:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        // إعادة المبلغ إلى رصيد الأستاذ
        const teacher = await getOne('teachers', 'id', request.teacher_id);
        if (teacher) {
            await supabase
                .from('teachers')
                .update({
                    balance: (teacher.balance || 0) + request.amount,
                    pending_withdraw: (teacher.pending_withdraw || 0) - request.amount
                })
                .eq('id', request.teacher_id);
        }

        // إرسال إشعار للأستاذ
        await insert('notifications', {
            user_id: request.teacher_id,
            user_type: 'teacher',
            title: 'تم رفض طلب السحب',
            message: `تم رفض طلب سحب مبلغ ${request.amount} دج. السبب: ${reason || 'لم يتم تحديد سبب'}`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        console.log(`✅ تم رفض طلب السحب ${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في رفض طلب سحب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إرسال إشعار لجميع الطلاب
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
        console.log(`📥 إرسال إشعار لجميع الطلاب: ${title}`);

        const { data: students, error: studentsError } = await supabase
            .from('students')
            .select('id')
            .eq('email_verified', true);

        if (studentsError) {
            console.error('❌ خطأ في جلب الطلاب:', studentsError);
            return res.status(500).json({ success: false, error: studentsError.message });
        }

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
            console.error('❌ خطأ في إرسال الإشعارات:', error);
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

        console.log(`✅ تم إرسال الإشعار إلى ${students.length} طالب`);
        res.json({
            success: true,
            students_count: students.length,
            message: `تم إرسال الإشعار إلى ${students.length} طالب`
        });
    } catch (error) {
        console.error('❌ خطأ في إرسال الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب الإشعارات المرسلة
// ============================================================
router.get('/sent-notifications', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب الإشعارات المرسلة...');
        
        const { data, error } = await supabase
            .from('admin_notifications')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب الإشعارات المرسلة:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} إشعار مرسل`);
        res.json(data || []);
    } catch (error) {
        console.error('❌ خطأ في جلب الإشعارات المرسلة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ حذف إشعار
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

        const id = parseInt(req.params.id);
        console.log(`📥 حذف إشعار ID: ${id}`);

        const { error } = await supabase
            .from('admin_notifications')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('❌ خطأ في حذف الإشعار:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم حذف الإشعار ${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في حذف الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ مراقبة الأداء
// ============================================================
router.get('/performance', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب معلومات الأداء...');
        
        const { data: connections, error: connError } = await supabase
            .from('active_stream')
            .select('count', { count: 'exact' });

        if (connError) {
            console.error('❌ خطأ في جلب البث المباشر:', connError);
        }

        const { data: sessions, error: sessError } = await supabase
            .from('sessions')
            .select('count', { count: 'exact' });

        if (sessError) {
            console.error('❌ خطأ في جلب الجلسات:', sessError);
        }

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
        console.error('❌ خطأ في مراقبة الأداء:', error.message);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// ============================================================
// ✅ رسائل الدعم - باستخدام جدول messages
// ============================================================
router.get('/support-messages', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب رسائل الدعم...');
        
        // استخدام جدول messages بدلاً من support_messages
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ خطأ في جلب رسائل الدعم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        // تحويل البيانات لتتناسب مع تنسيق رسائل الدعم
        const formattedMessages = (data || []).map(msg => ({
            id: msg.id,
            name: 'مستخدم',
            email: 'غير محدد',
            phone: null,
            subject: 'رسالة دعم',
            message: msg.message,
            status: msg.is_read ? 'read' : 'unread',
            created_at: msg.created_at,
            sender_id: msg.sender_id,
            sender_type: msg.sender_type,
            receiver_id: msg.receiver_id,
            receiver_type: msg.receiver_type
        }));

        console.log(`✅ تم جلب ${formattedMessages.length} رسالة دعم`);
        res.json(formattedMessages);
    } catch (error) {
        console.error('❌ خطأ في جلب رسائل الدعم:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ تحديث رسالة دعم كمقروءة
// ============================================================
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

        const id = parseInt(req.params.id);
        console.log(`📥 تحديث رسالة دعم ID: ${id} كمقروءة`);

        const { error } = await supabase
            .from('messages')
            .update({ is_read: true })
            .eq('id', id);

        if (error) {
            console.error('❌ خطأ في تحديث رسالة الدعم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم تحديث رسالة الدعم ${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في تحديث رسالة الدعم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ حذف رسالة دعم
// ============================================================
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

        const id = parseInt(req.params.id);
        console.log(`📥 حذف رسالة دعم ID: ${id}`);

        const { error } = await supabase
            .from('messages')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('❌ خطأ في حذف رسالة الدعم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم حذف رسالة الدعم ${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في حذف رسالة الدعم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
