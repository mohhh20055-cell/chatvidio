// ============================================================
// مسارات الطالب - Student Routes (مبسط ومستقر)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');

const { supabase } = require('../config/database');
const { authenticate, authorize, checkBanned } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');
const { uploadToSupabase, validateUploadedFiles } = require('../utils/upload');

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
// ✅ مسار /me أولاً (لتجنب التعارض مع /:student_id)
// ============================================================
router.get('/me', authenticate, authorize(['student']), async (req, res) => {
    try {
        console.log('📥 جلب معلومات الطالب الحالي:', req.user.userId);
        
        const student = await getOne('students', 'id', req.user.userId);
        if (!student) {
            console.log('❌ الطالب غير موجود:', req.user.userId);
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        delete student.password;
        
        console.log('✅ تم جلب بيانات الطالب:', student.full_name);
        res.json(student);
    } catch (error) {
        console.error('❌ خطأ في جلب معلومات الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب بيانات الطالب (بعد مسار /me)
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
        
        console.log(`📥 جلب بيانات الطالب ID: ${student_id}`);

        if (req.user.userId !== student_id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه المعلومات' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'طالب غير موجود' });
        }
        
        delete student.password;
        
        res.json(student);
    } catch (error) {
        console.error('خطأ في جلب بيانات الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث صورة الطالب
// ============================================================
router.post('/update-profile', authenticate, authorize(['student']), upload.single('profile_image'), validateUploadedFiles, [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id } = req.body;

        if (req.user.userId !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'الرجاء اختيار صورة' });
        }

        const oldStudent = await getOne('students', 'id', student_id);
        if (!oldStudent) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        const uploaded = await uploadToSupabase(req.file, 'students', oldStudent?.profile_image);
        if (!uploaded) {
            return res.status(500).json({ success: false, error: 'فشل رفع الصورة' });
        }

        const updateData = {
            profile_image: uploaded.filename,
            profile_url: uploaded.url
        };

        const { data, error } = await supabase
            .from('students')
            .update(updateData)
            .eq('id', student_id)
            .select();

        if (error) throw error;

        res.json({ 
            success: true, 
            message: 'تم تحديث الصورة الشخصية بنجاح', 
            user: data ? data[0] : null 
        });
    } catch (error) {
        console.error('خطأ في تحديث الصورة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث الملف الشخصي للطالب
// ============================================================
router.post('/update-profile-with-social', authenticate, authorize(['student']), upload.fields([
    { name: 'profile_image', maxCount: 1 }
]), validateUploadedFiles, [
    body('student_id').isInt().withMessage('معرف الطالب مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { 
            student_id,
            phone,
            full_name,
            education_level
        } = req.body;

        console.log('📝 تحديث الملف الشخصي للطالب:', student_id);

        if (req.user.userId !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        let profile_image = null;
        let profile_url = null;

        const oldStudent = await getOne('students', 'id', student_id);
        if (!oldStudent) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        if (req.files && req.files['profile_image'] && req.files['profile_image'][0]) {
            const file = req.files['profile_image'][0];
            const uploaded = await uploadToSupabase(file, 'students', oldStudent?.profile_image);
            if (uploaded) {
                profile_image = uploaded.filename;
                profile_url = uploaded.url;
            }
        }

        const updateData = {};

        if (profile_image) { updateData.profile_image = profile_image; }
        if (profile_url) { updateData.profile_url = profile_url; }
        if (phone !== undefined) { updateData.phone = phone.trim(); }
        if (full_name !== undefined && full_name.trim()) { updateData.full_name = full_name.trim(); }
        if (education_level !== undefined) { updateData.education_level = education_level.trim(); }

        console.log('💾 البيانات المراد تحديثها:', updateData);

        const { data, error } = await supabase
            .from('students')
            .update(updateData)
            .eq('id', student_id)
            .select();

        if (error) {
            console.error('❌ خطأ في تحديث قاعدة البيانات:', error);
            throw error;
        }

        const updatedStudent = data ? data[0] : null;

        console.log('✅ تم تحديث الملف الشخصي بنجاح');

        res.json({
            success: true,
            message: 'تم تحديث الملف الشخصي والمستوى التعليمي بنجاح',
            user: updatedStudent
        });
    } catch (error) {
        console.error('❌ خطأ في تحديث الملف الشخصي:', error.message);
        console.error('📚 Stack:', error.stack);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ أثناء تحديث الملف الشخصي' });
    }
});

// ============================================================
// ✅ تحديث المستوى التعليمي فقط (للإدارة فقط)
// ============================================================
router.post('/update-education-level', authenticate, authorize(['admin']), [
    body('student_id').isInt().withMessage('معرف الطالب مطلوب'),
    body('education_level').notEmpty().withMessage('المستوى التعليمي مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, education_level } = req.body;

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        const { data, error } = await supabase
            .from('students')
            .update({ education_level: education_level.trim() })
            .eq('id', student_id)
            .select();

        if (error) throw error;

        res.json({
            success: true,
            message: 'تم تحديث المستوى التعليمي بنجاح',
            education_level: education_level,
            user: data ? data[0] : null
        });
    } catch (error) {
        console.error('❌ خطأ في تحديث المستوى التعليمي:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب الرصيد والمحفظة
// ============================================================
router.get('/balance/:student_id', authenticate, authorize(['student']), [
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
        if (!student) {
            return res.status(404).json({ success: false, error: 'طالب غير موجود' });
        }

        // جلب الرصيد المعلق من الحجوزات (pending_balance غير موجود، نستخدم payment_amount)
        const { data: pendingSessions, error: pendingError } = await supabase
            .from('sessions')
            .select('payment_amount')
            .eq('student_id', student_id)
            .eq('payment_status', 'pending_stream');

        let totalPendingBalance = 0;
        if (!pendingError && pendingSessions) {
            totalPendingBalance = pendingSessions.reduce((sum, s) => sum + (s.payment_amount || 0), 0);
        }

        const { count: pendingCount, error: countError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('student_id', student_id)
            .eq('payment_status', 'pending_stream');

        if (countError) {
            console.error('خطأ في جلب عدد الحجوزات المعلقة:', countError.message);
        }

        // جلب سجل المعاملات من wallet_transactions
        const { data: transactions, error: transactionsError } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('student_id', student_id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (transactionsError) {
            console.error('خطأ في جلب المعاملات:', transactionsError.message);
        }

        res.json({
            balance: student.wallet_balance || 0,
            pending_balance: totalPendingBalance,
            pending_count: pendingCount || 0,
            referral_balance: student.referral_balance || 0,
            gift_box_chances: student.gift_box_chances || 0,
            transactions: transactions || []
        });
    } catch (error) {
        console.error('خطأ في جلب الرصيد:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب حجوزات الطالب
// ============================================================
router.get('/sessions/:student_id', authenticate, authorize(['student']), [
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

        const { data: sessions, error } = await supabase
            .from('sessions')
            .select(`
                *,
                offers:offer_id (
                    subject_name,
                    duration,
                    offer_date,
                    price,
                    is_free,
                    teacher_id,
                    stream_url,
                    room_name,
                    room_password,
                    status,
                    teachers:teacher_id (
                        id,
                        full_name,
                        profile_url,
                        specialization
                    )
                )
            `)
            .eq('student_id', student_id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('خطأ في جلب الحجوزات:', error.message);
            return res.status(500).json([]);
        }

        if (!sessions || sessions.length === 0) {
            return res.json([]);
        }

        const formatted = sessions.map(session => ({
            id: session.id,
            offer_id: session.offer_id,
            subject_name: session.offers?.subject_name || 'غير معروف',
            duration: session.offers?.duration || 0,
            offer_date: session.offers?.offer_date || null,
            price: session.offers?.price || 0,
            is_free: session.offers?.is_free || false,
            offer_status: session.offers?.status || 'pending',
            payment_status: session.payment_status,
            pending_balance: session.payment_amount || 0,
            is_pending_stream: session.payment_status === 'pending_stream',
            payment_method: session.payment_method,
            transaction_id: session.transaction_id,
            completed: session.completed || false,
            attended: session.attended || false,
            teacher_id: session.offers?.teacher_id || null,
            teacher_name: session.offers?.teachers?.full_name || 'غير معروف',
            teacher_profile: session.offers?.teachers?.profile_url || null,
            teacher_specialization: session.offers?.teachers?.specialization || '',
            stream_url: session.offers?.stream_url || null,
            room_name: session.offers?.room_name || null,
            room_password: session.offers?.room_password || null,
            created_at: session.created_at,
            updated_at: session.updated_at
        }));

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب حجوزات الطالب:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// جلب جلسة محددة للطالب
// ============================================================
router.get('/session/:session_id', authenticate, authorize(['student']), [
    param('session_id').isInt().withMessage('معرف الجلسة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const session_id = parseInt(req.params.session_id);

        const { data: session, error } = await supabase
            .from('sessions')
            .select(`
                *,
                offers:offer_id (
                    subject_name,
                    duration,
                    offer_date,
                    price,
                    is_free,
                    teacher_id,
                    stream_url,
                    room_name,
                    room_password,
                    status,
                    teachers:teacher_id (
                        id,
                        full_name,
                        profile_url,
                        specialization,
                        bio,
                        experience
                    )
                )
            `)
            .eq('id', session_id)
            .single();

        if (error || !session) {
            return res.status(404).json({ success: false, error: 'الجلسة غير موجودة' });
        }

        if (session.student_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بعرض هذه الجلسة' });
        }

        res.json({
            id: session.id,
            offer_id: session.offer_id,
            subject_name: session.offers?.subject_name || 'غير معروف',
            duration: session.offers?.duration || 0,
            offer_date: session.offers?.offer_date || null,
            price: session.offers?.price || 0,
            is_free: session.offers?.is_free || false,
            offer_status: session.offers?.status || 'pending',
            payment_status: session.payment_status,
            pending_balance: session.payment_amount || 0,
            is_pending_stream: session.payment_status === 'pending_stream',
            payment_method: session.payment_method,
            transaction_id: session.transaction_id,
            completed: session.completed || false,
            attended: session.attended || false,
            teacher_id: session.offers?.teacher_id || null,
            teacher_name: session.offers?.teachers?.full_name || 'غير معروف',
            teacher_profile: session.offers?.teachers?.profile_url || null,
            teacher_specialization: session.offers?.teachers?.specialization || '',
            teacher_bio: session.offers?.teachers?.bio || '',
            teacher_experience: session.offers?.teachers?.experience || 0,
            stream_url: session.offers?.stream_url || null,
            room_name: session.offers?.room_name || null,
            room_password: session.offers?.room_password || null,
            created_at: session.created_at,
            updated_at: session.updated_at
        });
    } catch (error) {
        console.error('خطأ في جلب الجلسة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إنشاء حجز جديد
// ============================================================
router.post('/create-session', authenticate, authorize(['student']), [
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('payment_method').isIn(['chargily', 'edahabia', 'ccp']).withMessage('طريقة الدفع غير صالحة')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, payment_method } = req.body;
        const student_id = req.user.userId;

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.status === 'cancelled') {
            return res.status(400).json({ success: false, error: 'هذا العرض ملغى' });
        }

        const existingSession = await supabase
            .from('sessions')
            .select('id, payment_status')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .single();

        if (existingSession?.data) {
            if (existingSession.data.payment_status === 'paid' || existingSession.data.payment_status === 'pending_stream') {
                return res.status(400).json({ success: false, error: 'لقد قمت بالفعل بحجز هذا العرض' });
            }
            if (existingSession.data.payment_status === 'pending') {
                return res.status(400).json({ success: false, error: 'لديك حجز معلق لهذا العرض، يرجى إكمال الدفع' });
            }
        }

        if (!offer.is_free && offer.price > 0) {
            const student = await getOne('students', 'id', student_id);
            if (!student) {
                return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
            }

            if ((student.wallet_balance || 0) < offer.price) {
                return res.status(400).json({ 
                    success: false, 
                    error: `رصيدك غير كافٍ. الرصيد الحالي: ${student.wallet_balance} دج، المطلوب: ${offer.price} دج`,
                    insufficient_balance: true,
                    needed: offer.price - (student.wallet_balance || 0)
                });
            }
        }

        const sessionData = {
            student_id: student_id,
            offer_id: offer_id,
            payment_method: payment_method,
            payment_status: 'pending_stream',
            payment_amount: offer.is_free ? 0 : offer.price,
            pending_balance: offer.is_free ? 0 : offer.price,
            created_at: new Date().toISOString()
        };

        const newSession = await insert('sessions', sessionData);

        if (!offer.is_free && offer.price > 0) {
            const student = await getOne('students', 'id', student_id);
            if (student) {
                await update('students', student_id, {
                    wallet_balance: (student.wallet_balance || 0) - offer.price
                });

                await insert('wallet_transactions', {
                    student_id: student_id,
                    amount: offer.price,
                    type: 'withdraw',
                    status: 'pending_stream',
                    description: `حجز حصة "${offer.subject_name}" (في انتظار البث)`,
                    created_at: new Date().toISOString()
                });
            }

            const teacher = await getOne('teachers', 'id', offer.teacher_id);
            if (teacher) {
                await update('teachers', offer.teacher_id, {
                    pending_withdraw: (teacher.pending_withdraw || 0) + offer.price
                });
            }
        }

        await supabase
            .from('waiting_room')
            .insert({
                offer_id: offer_id,
                student_id: student_id,
                joined_at: new Date().toISOString()
            });

        await insert('notifications', {
            user_id: student_id,
            user_type: 'student',
            title: offer.is_free ? '✅ تم حجز الحصة المجانية' : '✅ تم حجز الحصة بنجاح',
            message: offer.is_free 
                ? `لقد قمت بحجز الحصة "${offer.subject_name}" بنجاح (حصة مجانية). سيتم إشعارك عند بدء البث.`
                : `لقد قمت بحجز الحصة "${offer.subject_name}" بنجاح. تم خصم ${offer.price} دج من رصيدك (رصيد معلق حتى انتهاء البث).`,
            offer_id: offer_id,
            is_read: false,
            created_at: new Date().toISOString()
        });

        const teacher = await getOne('teachers', 'id', offer.teacher_id);
        if (teacher) {
            await insert('notifications', {
                user_id: offer.teacher_id,
                user_type: 'teacher',
                title: '📚 حجز جديد',
                message: `قام طالب بحجز درس "${offer.subject_name}"`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            });
        }

        const { count: bookedCount } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .in('payment_status', ['paid', 'pending_stream']);

        await update('offers', offer_id, {
            booked_count: bookedCount || 0
        });

        res.json({
            success: true,
            message: 'تم إنشاء الحجز بنجاح',
            session_id: newSession.id,
            amount: offer.is_free ? 0 : offer.price,
            is_free: offer.is_free,
            pending_balance: offer.is_free ? 0 : offer.price,
            payment_method: payment_method,
            total_booked: bookedCount || 0
        });
    } catch (error) {
        console.error('خطأ في إنشاء الحجز:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تأكيد الدفع
// ============================================================
router.post('/confirm-payment', authenticate, authorize(['student']), [
    body('session_id').isInt().withMessage('معرف الجلسة غير صالح'),
    body('transaction_id').optional().isString().withMessage('معرف المعاملة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { session_id, transaction_id } = req.body;
        const student_id = req.user.userId;

        const session = await getOne('sessions', 'id', session_id);
        if (!session) {
            return res.status(404).json({ success: false, error: 'الجلسة غير موجودة' });
        }

        if (session.student_id !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        if (session.payment_status === 'paid') {
            return res.status(400).json({ success: false, error: 'هذه الجلسة مدفوعة بالفعل' });
        }

        const offer = await getOne('offers', 'id', session.offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        const updateData = {
            payment_status: 'paid',
            payment_date: new Date().toISOString(),
            pending_balance: 0
        };

        if (transaction_id) {
            updateData.transaction_id = transaction_id;
        }

        const updatedSession = await update('sessions', session_id, updateData);

        await insert('notifications', {
            user_id: student_id,
            user_type: 'student',
            title: '✅ تم تأكيد الحجز',
            message: `تم تأكيد حجزك للدرس "${offer.subject_name}" بنجاح`,
            offer_id: offer.id,
            is_read: false,
            created_at: new Date().toISOString()
        });

        await insert('notifications', {
            user_id: offer.teacher_id,
            user_type: 'teacher',
            title: '📚 حجز جديد',
            message: `قام طالب بحجز درس "${offer.subject_name}"`,
            offer_id: offer.id,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: 'تم تأكيد الحجز بنجاح',
            session: updatedSession
        });
    } catch (error) {
        console.error('خطأ في تأكيد الدفع:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إلغاء حجز
// ============================================================
router.post('/cancel-session/:session_id', authenticate, authorize(['student']), [
    param('session_id').isInt().withMessage('معرف الجلسة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const session_id = parseInt(req.params.session_id);
        const student_id = req.user.userId;

        const session = await getOne('sessions', 'id', session_id);
        if (!session) {
            return res.status(404).json({ success: false, error: 'الجلسة غير موجودة' });
        }

        if (session.student_id !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', session.offer_id);
        if (offer && (offer.status === 'live' || offer.status === 'teacher_ready')) {
            return res.status(400).json({ 
                success: false, 
                error: 'لا يمكن إلغاء الحجز بعد بدء البث' 
            });
        }

        let refundAmount = 0;

        if (session.payment_status === 'pending_stream' && session.payment_amount > 0) {
            refundAmount = session.payment_amount;
            
            const student = await getOne('students', 'id', student_id);
            if (student) {
                await update('students', student_id, {
                    wallet_balance: (student.wallet_balance || 0) + refundAmount
                });
            }

            if (offer) {
                const teacher = await getOne('teachers', 'id', offer.teacher_id);
                if (teacher) {
                    await update('teachers', offer.teacher_id, {
                        pending_withdraw: Math.max(0, (teacher.pending_withdraw || 0) - refundAmount)
                    });
                }
            }

            await insert('wallet_transactions', {
                student_id: student_id,
                amount: refundAmount,
                type: 'refund',
                status: 'completed',
                description: `استرداد مبلغ حجز "${offer?.subject_name || 'غير معروف'}"`,
                created_at: new Date().toISOString()
            });
        }

        await update('sessions', session_id, {
            payment_status: 'cancelled',
            cancelled_at: new Date().toISOString(),
            pending_balance: 0
        });

        await supabase
            .from('waiting_room')
            .delete()
            .eq('offer_id', session.offer_id)
            .eq('student_id', student_id);

        if (offer) {
            const { count: bookedCount } = await supabase
                .from('sessions')
                .select('*', { count: 'exact', head: true })
                .eq('offer_id', offer.id)
                .in('payment_status', ['paid', 'pending_stream']);

            await update('offers', offer.id, {
                booked_count: bookedCount || 0
            });
        }

        res.json({
            success: true,
            message: 'تم إلغاء الحجز واسترداد الرصيد بنجاح',
            refund_amount: refundAmount
        });
    } catch (error) {
        console.error('خطأ في إلغاء الحجز:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب الإشعارات
// ============================================================
router.get('/notifications/:student_id', authenticate, authorize(['student']), [
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data, error } = await supabase
            .from('notifications')
            .select('*')
            .eq('user_id', student_id)
            .eq('user_type', 'student')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json(data || []);
    } catch (error) {
        console.error('خطأ في جلب الإشعارات:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// تحديد إشعار كمقروء
// ============================================================
router.put('/notification/read/:notification_id', authenticate, authorize(['student']), [
    param('notification_id').isInt().withMessage('معرف الإشعار غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const notification_id = parseInt(req.params.notification_id);

        const notification = await getOne('notifications', 'id', notification_id);
        if (!notification) {
            return res.status(404).json({ success: false, error: 'الإشعار غير موجود' });
        }

        if (notification.user_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        await update('notifications', notification_id, {
            is_read: true,
            read_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: 'تم تحديد الإشعار كمقروء'
        });
    } catch (error) {
        console.error('خطأ في تحديث الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديد جميع الإشعارات كمقروءة
// ============================================================
router.put('/notifications/read-all', authenticate, authorize(['student']), [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id } = req.body;

        if (req.user.userId !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { error } = await supabase
            .from('notifications')
            .update({
                is_read: true,
                read_at: new Date().toISOString()
            })
            .eq('user_id', student_id)
            .eq('user_type', 'student')
            .eq('is_read', false);

        if (error) throw error;

        res.json({
            success: true,
            message: 'تم تحديد جميع الإشعارات كمقروءة'
        });
    } catch (error) {
        console.error('خطأ في تحديث الإشعارات:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب الإحصائيات للطالب
// ============================================================
router.get('/stats/:student_id', authenticate, authorize(['student']), [
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { count: totalSessions, error: totalError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('student_id', student_id);

        if (totalError) {
            console.error('خطأ في جلب عدد الحجوزات:', totalError.message);
        }

        const { count: paidSessions, error: paidError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('student_id', student_id)
            .eq('payment_status', 'paid');

        if (paidError) {
            console.error('خطأ في جلب عدد الحجوزات المدفوعة:', paidError.message);
        }

        const { count: completedSessions, error: completedError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('student_id', student_id)
            .eq('payment_status', 'paid')
            .eq('completed', true);

        if (completedError) {
            console.error('خطأ في جلب عدد الحجوزات المكتملة:', completedError.message);
        }

        const { count: unreadNotifications, error: unreadError } = await supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', student_id)
            .eq('user_type', 'student')
            .eq('is_read', false);

        if (unreadError) {
            console.error('خطأ في جلب عدد الإشعارات غير المقروءة:', unreadError.message);
        }

        res.json({
            total_sessions: totalSessions || 0,
            paid_sessions: paidSessions || 0,
            completed_sessions: completedSessions || 0,
            unread_notifications: unreadNotifications || 0
        });
    } catch (error) {
        console.error('خطأ في جلب إحصائيات الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب حالة البث للطالب
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

        const offer_id = parseInt(req.params.offer_id);
        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.json({ can_join: false, error: 'العرض غير موجود' });
        }

        const session = await getOne('sessions', 'offer_id', offer_id);
        if (!session || session.student_id !== student_id) {
            return res.json({ can_join: false, error: 'لم تقم بحجز هذه الحصة' });
        }

        const isPaid = session.payment_status === 'paid' || session.payment_status === 'pending_stream';
        if (!isPaid) {
            return res.json({ can_join: false, error: 'لم يتم دفع الحصة' });
        }

        const isLive = offer.status === 'live' || offer.status === 'teacher_ready';
        const isPaused = offer.status === 'paused';
        const isActive = isLive || isPaused;

        const { data: active } = await supabase
            .from('active_stream')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .single();

        const isInStream = !!active;

        res.json({
            can_join: isActive && isInStream,
            is_waiting: isActive && !isInStream,
            is_paused: isPaused,
            stream_url: offer.stream_url || null,
            room_password: offer.room_password || null,
            duration: offer.duration || 0,
            status: offer.status,
            subject_name: offer.subject_name,
            teacher_id: offer.teacher_id
        });
    } catch (error) {
        console.error('خطأ في جلب حالة البث للطالب:', error.message);
        res.status(500).json({ can_join: false, error: error.message });
    }
});

module.exports = router;
