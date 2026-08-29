const logger = require('../utils/logger');
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
const { getOne, insert, update, remove, isNameTaken, autoBookFreeSession } = require('../utils/helpers');
const { uploadToSupabase, validateUploadedFiles, getPublicImageUrl, processUserProfile } = require('../utils/upload');
const { isValidDzPhone } = require('../utils/validation');

const fs = require('fs');
const studentFollowersFilePath = path.join(__dirname, '../data/student_followers.json');

async function loadLocalStudentFollowers() {
    try {
        if (fs.existsSync(studentFollowersFilePath)) {
            const content = await fs.promises.readFile(studentFollowersFilePath, 'utf8');
            return JSON.parse(content) || [];
        }
    } catch (e) {}
    return [];
}

async function saveLocalStudentFollowers(list) {
    try {
        const dir = path.dirname(studentFollowersFilePath);
        if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(studentFollowersFilePath, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {}
}

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit

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
        if (req.user.userId === -1 || req.user.userId === '-1') {
            return res.json({
                id: -1,
                full_name: 'طالب زائر',
                email: 'guest@zoomdz.com',
                is_guest: true,
                role: 'student',
                balance: 0
            });
        }
        console.log('📥 جلب معلومات الطالب الحالي:', req.user.userId);
        
        const student = await getOne('students', 'id', req.user.userId);
        if (!student) {
            console.log('❌ الطالب غير موجود:', req.user.userId);
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        student.profile_image = student.profile_url || getPublicImageUrl('profiles', 'students', student.profile_image);
        delete student.password;
        
        console.log('✅ تم جلب بيانات الطالب:', student.full_name);
        res.json(student);
    } catch (error) {
        logger.error('❌ خطأ في جلب معلومات الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ شراء باقة نقاط المعلم الذكي (AI Tokens) باستخدام رصيد المحفظة
// ============================================================
router.post('/buy-tokens', authenticate, authorize(['student', 'teacher']), async (req, res) => {
    try {
        const userId = req.user.userId;
        const userRole = req.user.role || req.user.userType || 'student';
        const isTeacher = (userRole === 'teacher');
        if (!userId || userId === -1 || userId === '-1') {
            return res.status(401).json({ success: false, error: 'يجب تسجيل الدخول لإتمام هذه العملية.' });
        }

        const { packageId } = req.body;
        
        // تعريف باقات النقاط المتاحة وأسعارها بالدينار الجزائري (DZD)
        const packages = {
            'bronze': { tokens: 20, price: 30, name: 'الباقة البرونزية' },
            'silver': { tokens: 100, price: 100, name: 'الباقة الفضية' },
            'gold': { tokens: 300, price: 250, name: 'الباقة الذهبية' },
            'platinum': { tokens: 1000, price: 700, name: 'الباقة البلاتينية' }
        };

        const selectedPackage = packages[packageId];
        if (!selectedPackage) {
            return res.status(400).json({ success: false, error: 'الباقة المحددة غير صالحة.' });
        }

        const table = isTeacher ? 'teachers' : 'students';
        const balanceField = isTeacher ? 'balance' : 'wallet_balance';

        const user = await getOne(table, 'id', userId);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود.' });
        }

        const currentBalance = user[balanceField] || user.wallet_balance || user.balance || 0;
        if (currentBalance < selectedPackage.price) {
            return res.status(400).json({ 
                success: false, 
                error: `رصيدك غير كافٍ لشراء هذه الباقة. الرصيد الحالي: ${currentBalance} دج، سعر الباقة: ${selectedPackage.price} دج.`,
                insufficient_balance: true
            });
        }

        const currentTokens = user.ai_tokens !== undefined && user.ai_tokens !== null ? user.ai_tokens : 50; // Default to 50 free tokens
        const newBalance = currentBalance - selectedPackage.price;
        const newTokens = currentTokens + selectedPackage.tokens;

        // تحديث الرصيد ونقاط المعلم الذكي
        const updateData = {
            ai_tokens: newTokens
        };
        updateData[balanceField] = newBalance;

        await update(table, userId, updateData);

        if (!isTeacher) {
            // تسجيل العملية في جدول المعاملات للطالب
            await insert('wallet_transactions', {
                student_id: userId,
                amount: selectedPackage.price,
                type: 'withdraw',
                status: 'completed',
                description: `شراء ${selectedPackage.name} للمعلم الذكي (+${selectedPackage.tokens} نقطة)`
            });
        }

        res.json({
            success: true,
            message: `تم شراء ${selectedPackage.name} بنجاح! تم شحن ${selectedPackage.tokens} نقطة إلى حسابك وخصم ${selectedPackage.price} دج من رصيدك.`,
            wallet_balance: newBalance,
            ai_tokens: newTokens
        });

    } catch (error) {
        logger.error('❌ خطأ في شراء باقة نقاط المعلم الذكي:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء معالجة عملية الشراء.' });
    }
});

// ============================================================
// ✅ جلب الملف الشخصي العام لطالب معين (للأساتذة والطلاب)
// ============================================================
router.get('/public/student/:student_id', authenticate, async (req, res) => {
    try {
        const student_id = parseInt(req.params.student_id);
        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }
        delete student.password;
        delete student.phone;
        const rawImg = student.profile_url || student.profile_image;
        let img = '/images/default-avatar.svg';
        if (rawImg && rawImg !== 'null' && rawImg !== 'undefined' && rawImg !== 'NULL') {
            if (rawImg.startsWith('http://') || rawImg.startsWith('https://') || rawImg.startsWith('data:') || rawImg.startsWith('/')) {
                img = rawImg;
            } else {
                img = getPublicImageUrl('profiles', 'students', rawImg) || rawImg;
            }
        }
        student.profile_image = img;

        // Fetch followers count and follow status
        let followersCount = 0;
        let isFollowing = false;
        let querySucceeded = false;

        const currentUserId = parseInt(req.user.userId);
        const currentUserRole = req.user.role;

        try {
            const { count, error: countErr } = await supabase
                .from('student_followers')
                .select('*', { count: 'exact', head: true })
                .eq('student_id', student_id);

            if (!countErr) {
                followersCount = count || 0;
                querySucceeded = true;

                const { data: followRec, error: followErr } = await supabase
                    .from('student_followers')
                    .select('id')
                    .eq('student_id', student_id)
                    .eq('follower_id', currentUserId)
                    .eq('follower_type', currentUserRole)
                    .limit(1);

                if (!followErr && followRec && followRec.length > 0) {
                    isFollowing = true;
                }
            }
        } catch (fErr) {}

        // Combine / fallback with local file store
        const localList = await loadLocalStudentFollowers();
        const localIsFollowing = localList.some(
            f => parseInt(f.student_id) === student_id && parseInt(f.follower_id) === currentUserId && f.follower_type === currentUserRole
        );
        const localCount = localList.filter(f => parseInt(f.student_id) === student_id).length;

        if (!querySucceeded) {
            followersCount = localCount;
            isFollowing = localIsFollowing;
        } else {
            if (localIsFollowing) isFollowing = true;
            if (localCount > followersCount) followersCount = localCount;
        }

        student.followers_count = followersCount;
        student.is_following = isFollowing;

        res.json({ success: true, student });
    } catch (error) {
        logger.error('خطأ في جلب ملف الطالب العام:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ تبديل متابعة طالب (Follow / Unfollow Student)
// ============================================================
router.post('/toggle-follow', authenticate, async (req, res) => {
    try {
        const student_id = parseInt(req.body.student_id);
        const follower_id = parseInt(req.user.userId);
        const follower_type = req.user.role;

        if (!student_id) {
            return res.status(400).json({ success: false, error: 'معرف الطالب مطلوب' });
        }

        let isFollowing = false;

        // 1. Local store state calculation & update
        let localList = await loadLocalStudentFollowers();
        const existingIdx = localList.findIndex(
            f => parseInt(f.student_id) === student_id && parseInt(f.follower_id) === follower_id && f.follower_type === follower_type
        );

        if (existingIdx !== -1) {
            localList.splice(existingIdx, 1);
            isFollowing = false;
        } else {
            localList.push({
                student_id,
                follower_id,
                follower_type,
                created_at: new Date().toISOString()
            });
            isFollowing = true;
        }
        await saveLocalStudentFollowers(localList);

        // 2. Try Supabase synchronization
        try {
            const { data: existing, error: checkErr } = await supabase
                .from('student_followers')
                .select('id')
                .eq('student_id', student_id)
                .eq('follower_id', follower_id)
                .eq('follower_type', follower_type)
                .limit(1);

            if (!checkErr) {
                if (existing && existing.length > 0) {
                    await supabase
                        .from('student_followers')
                        .delete()
                        .eq('student_id', student_id)
                        .eq('follower_id', follower_id)
                        .eq('follower_type', follower_type);
                } else {
                    await supabase
                        .from('student_followers')
                        .insert({ student_id, follower_id, follower_type });
                }
            }
        } catch (sbErr) {}

        // Get updated followers count
        let newFollowersCount = localList.filter(f => parseInt(f.student_id) === student_id).length;
        try {
            const { count } = await supabase
                .from('student_followers')
                .select('*', { count: 'exact', head: true })
                .eq('student_id', student_id);
            if (count !== null && count !== undefined && count > newFollowersCount) {
                newFollowersCount = count;
            }
        } catch (cErr) {}

        return res.json({ 
            success: true, 
            is_following: isFollowing, 
            followers_count: newFollowersCount,
            message: isFollowing ? 'تمت المتابعة بنجاح' : 'تم إلغاء المتابعة' 
        });
    } catch (e) {
        logger.error('Error toggling student follow:', e.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في المتابعة' });
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

        if (Number(req.user.userId) !== Number(student_id) && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بدرس هذه المعلومات' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'طالب غير موجود' });
        }
        
        delete student.password;
        
        res.json(student);
    } catch (error) {
        logger.error('خطأ في جلب بيانات الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث ملف الطالب (الصورة، الاسم، الهاتف، المستوى الدراسي)
// ============================================================
router.post('/update-profile', authenticate, authorize(['student']), upload.single('profile_image'), validateUploadedFiles, [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, phone, full_name, education_level } = req.body;

        if (req.user.userId !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الملف' });
        }

        const oldStudent = await getOne('students', 'id', student_id);
        if (!oldStudent) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        const updateData = {};

        if (req.file) {
            const uploaded = await uploadToSupabase(req.file, 'students', oldStudent?.profile_image);
            if (uploaded) {
                updateData.profile_image = uploaded.url;
                updateData.profile_url = uploaded.url;
            }
        }

        if (phone !== undefined) { 
            const trimmedPhone = String(phone).trim();
            if (trimmedPhone && !isValidDzPhone(trimmedPhone)) {
                return res.status(400).json({ success: false, error: '⚠️ رقم الهاتف يجب أن يكون برقم جزائري صحيح (مثال: 0550123456 أو 0660123456 أو 0770123456)' });
            }
            updateData.phone = trimmedPhone; 
        }
        if (full_name !== undefined && String(full_name).trim()) { 
            const newName = String(full_name).trim();
            if (newName !== (oldStudent.full_name || oldStudent.name)) {
                const nameCheck = await isNameTaken(newName, student_id, 'student');
                if (nameCheck.taken) {
                    return res.status(400).json({
                        success: false,
                        error: '⚠️ هذا الاسم مستخدم مسبقاً في المنصة. يرجى اختيار اسم فريد.'
                    });
                }
            }
            updateData.full_name = newName; 
        }
        if (education_level !== undefined && String(education_level).trim()) { updateData.education_level = String(education_level).trim(); }

        if (Object.keys(updateData).length === 0) {
            return res.json({ 
                success: true, 
                message: 'لم يتم تعديل أي بيانات', 
                user: processUserProfile(oldStudent, 'student') 
            });
        }

        const { data, error } = await supabase
            .from('students')
            .update(updateData)
            .eq('id', student_id)
            .select();

        if (error) throw error;

        const updatedStudent = (data && data.length > 0) ? data[0] : oldStudent;

        res.json({ 
            success: true, 
            message: 'تم تحديث الملف الشخصي والمستوى الدراسي بنجاح', 
            user: processUserProfile(updatedStudent, 'student') 
        });
    } catch (error) {
        logger.error('خطأ في تحديث البروفايل:', error.message);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// تحديث الملف الشخصي للطالب (مع حقول إضافية إن وُجدت)
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

        const oldStudent = await getOne('students', 'id', student_id);
        if (!oldStudent) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        if (req.files && req.files['profile_image'] && req.files['profile_image'][0]) {
            const file = req.files['profile_image'][0];
            const uploaded = await uploadToSupabase(file, 'students', oldStudent?.profile_image);
            if (uploaded) {
                profile_image = uploaded.url;
            }
        }

        const updateData = {};

        if (profile_image) { 
            updateData.profile_image = profile_image;
            updateData.profile_url = profile_image;
        }
        if (phone !== undefined) { updateData.phone = String(phone).trim(); }
        if (full_name !== undefined && String(full_name).trim()) { 
            const newName = String(full_name).trim();
            if (newName !== (oldStudent.full_name || oldStudent.name)) {
                const nameCheck = await isNameTaken(newName, student_id, 'student');
                if (nameCheck.taken) {
                    return res.status(400).json({
                        success: false,
                        error: '⚠️ هذا الاسم مستخدم مسبقاً في المنصة. يرجى اختيار اسم فريد.'
                    });
                }
            }
            updateData.full_name = newName; 
        }
        if (education_level !== undefined && String(education_level).trim()) { updateData.education_level = String(education_level).trim(); }

        console.log('💾 البيانات المراد تحديثها:', updateData);

        const { data, error } = await supabase
            .from('students')
            .update(updateData)
            .eq('id', student_id)
            .select();

        if (error) {
            logger.error('❌ خطأ في تحديث قاعدة البيانات:', error);
            throw error;
        }

        const updatedStudent = data ? data[0] : oldStudent;

        console.log('✅ تم تحديث الملف الشخصي بنجاح');

        res.json({
            success: true,
            message: 'تم تحديث الملف الشخصي والمستوى التعليمي بنجاح',
            user: processUserProfile(updatedStudent, 'student')
        });
    } catch (error) {
        logger.error('❌ خطأ في تحديث الملف الشخصي:', error.message);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ أثناء تحديث الملف الشخصي' });
    }
});

// ============================================================
// ✅ تحديث المستوى التعليمي فقط
// ============================================================
router.post('/update-education-level', authenticate, authorize(['student', 'admin']), [
    body('student_id').isInt().withMessage('معرف الطالب مطلوب'),
    body('education_level').notEmpty().withMessage('المستوى التعليمي مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, education_level } = req.body;

        if (req.user.role === 'student' && req.user.userId !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتغيير هذا المستوى' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        const { data, error } = await supabase
            .from('students')
            .update({ education_level: String(education_level).trim() })
            .eq('id', student_id)
            .select();

        if (error) throw error;

        const updatedStudent = data ? data[0] : student;

        res.json({
            success: true,
            message: 'تم تحديث المستوى التعليمي بنجاح',
            user: processUserProfile(updatedStudent, 'student')
        });
    } catch (error) {
        logger.error('❌ خطأ في تحديث المستوى التعليمي:', error.message);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب الرصيد والمحفظة
// ============================================================
router.get('/balance/:student_id', authenticate, authorize(['student']), [
    param('student_id').isInt({ allow_leading_zeroes: true, min: -1 }).withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const student_id = parseInt(req.params.student_id);
        if (student_id === -1 || Number(req.user.userId) === -1 || req.user.userId === '-1') {
            return res.json({ success: true, balance: 0, test_balance: 0, transactions: [] });
        }
        
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        if (Number(req.user.userId) !== Number(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بدرس هذه المعلومات' });
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
            logger.error('خطأ في جلب عدد الحجوزات المعلقة:', countError.message);
        }

        // جلب سجل المعاملات من wallet_transactions
        const { data: transactions, error: transactionsError } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('student_id', student_id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (transactionsError) {
            logger.error('خطأ في جلب المعاملات:', transactionsError.message);
        }

        res.json({
            balance: student.wallet_balance || 0,
            pending_balance: totalPendingBalance,
            pending_count: pendingCount || 0,
            referral_balance: student.referral_balance || 0,
            gift_box_chances: student.gift_box_chances || 0,
            ai_tokens: student.ai_tokens !== undefined && student.ai_tokens !== null ? student.ai_tokens : 50,
            transactions: transactions || []
        });
    } catch (error) {
        logger.error('خطأ في جلب الرصيد:', error.message);
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

        if (Number(req.user.userId) !== Number(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بدرس هذه المعلومات' });
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
                        specialization,
                        profile_image,
                        profile_url
                    )
                )
            `)
            .eq('student_id', student_id)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('خطأ في جلب الحجوزات:', error.message);
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
            is_free: (session.offers?.is_free === true || session.offers?.is_free === 'true' || session.offers?.is_free === 1) && parseFloat(session.offers?.price || 0) === 0,
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
            teacher_profile: session.offers?.teachers?.profile_url || getPublicImageUrl('profiles', 'teachers', session.offers?.teachers?.profile_image) || null,
            teacher_specialization: session.offers?.teachers?.specialization || '',
            stream_url: session.offers?.stream_url || null,
            room_name: session.offers?.room_name || null,
            room_password: session.offers?.room_password || null,
            created_at: session.created_at,
            updated_at: session.updated_at
        }));

        res.json(formatted);
    } catch (error) {
        logger.error('خطأ في جلب حجوزات الطالب:', error.message);
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
                        specialization,
                        bio,
                        experience,
                        profile_image,
                        profile_url
                    )
                )
            `)
            .eq('id', session_id)
            .single();

        if (error || !session) {
            return res.status(404).json({ success: false, error: 'الجلسة غير موجودة' });
        }

        if (session.student_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بدرس هذه الجلسة' });
        }

        res.json({
            id: session.id,
            offer_id: session.offer_id,
            subject_name: session.offers?.subject_name || 'غير معروف',
            duration: session.offers?.duration || 0,
            offer_date: session.offers?.offer_date || null,
            price: session.offers?.price || 0,
            is_free: (session.offers?.is_free === true || session.offers?.is_free === 'true' || session.offers?.is_free === 1) && parseFloat(session.offers?.price || 0) === 0,
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
            teacher_profile: session.offers?.teachers?.profile_url || getPublicImageUrl('profiles', 'teachers', session.offers?.teachers?.profile_image) || null,
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
        logger.error('خطأ في جلب الجلسة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// إنشاء حجز جديد
// ============================================================
router.post('/create-session', authenticate, authorize(['student']), [
    body('offer_id').isInt().withMessage('معرف الدرس غير صالح'),
    body('payment_method').isIn(['sofizpay', 'edahabia', 'ccp']).withMessage('طريقة الدفع غير صالحة')
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
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        if (offer.status === 'cancelled') {
            return res.status(400).json({ success: false, error: 'هذا الدرس ملغى' });
        }

        const existingSession = await supabase
            .from('sessions')
            .select('id, payment_status')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .single();

        if (existingSession?.data) {
            if (existingSession.data.payment_status === 'paid' || existingSession.data.payment_status === 'pending_stream') {
                return res.status(400).json({ success: false, error: 'لقد قمت بالفعل بحجز هذا الدرس' });
            }
            if (existingSession.data.payment_status === 'pending') {
                return res.status(400).json({ success: false, error: 'لديك حجز معلق لهذا الدرس، يرجى إكمال الدفع' });
            }
        }

        // تحسين التحقق من أن العرض مجاني
        const isFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0;

        if (!isFree) {
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
            payment_amount: isFree ? 0 : offer.price,
            pending_balance: isFree ? 0 : offer.price,
            created_at: new Date().toISOString()
        };

        const newSession = await insert('sessions', sessionData);

        if (!isFree) {
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
                added_at: new Date().toISOString()
            });

        await insert('notifications', {
            user_id: student_id,
            user_type: 'student',
            title: isFree ? '✅ تم حجز الحصة المجانية' : '✅ تم حجز الحصة بنجاح',
            message: isFree 
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
            amount: isFree ? 0 : offer.price,
            is_free: isFree,
            pending_balance: isFree ? 0 : offer.price,
            payment_method: payment_method,
            total_booked: bookedCount || 0
        });
    } catch (error) {
        logger.error('خطأ في إنشاء الحجز:', error.message);
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
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
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
        logger.error('خطأ في تأكيد الدفع:', error.message);
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
        const isOfferFree = offer ? ((offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0) : false;

        if (session.payment_status === 'pending_stream' && session.payment_amount > 0 && !isOfferFree) {
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
        logger.error('خطأ في إلغاء الحجز:', error.message);
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

        if (Number(req.user.userId) !== Number(student_id)) {
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
        logger.error('خطأ في جلب الإشعارات:', error.message);
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
            is_read: true
        });

        res.json({
            success: true,
            message: 'تم تحديد الإشعار كمقروء'
        });
    } catch (error) {
        logger.error('خطأ في تحديث الإشعار:', error.message);
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
                is_read: true
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
        logger.error('خطأ في تحديث الإشعارات:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// مسح جميع الإشعارات للطالب
// ============================================================
router.delete('/notifications/clear-all', authenticate, authorize(['student']), async (req, res) => {
    try {
        const student_id = req.user.userId;

        const { error } = await supabase
            .from('notifications')
            .delete()
            .eq('user_id', student_id)
            .eq('user_type', 'student');

        if (error) throw error;

        res.json({
            success: true,
            message: 'تم مسح جميع الإشعارات بنجاح'
        });
    } catch (error) {
        logger.error('خطأ في مسح الإشعارات:', error.message);
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

        if (Number(req.user.userId) !== Number(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { count: totalSessions, error: totalError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('student_id', student_id);

        if (totalError) {
            logger.error('خطأ في جلب عدد الحجوزات:', totalError.message);
        }

        const { count: paidSessions, error: paidError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('student_id', student_id)
            .eq('payment_status', 'paid');

        if (paidError) {
            logger.error('خطأ في جلب عدد الحجوزات المدفوعة:', paidError.message);
        }

        const { count: completedSessions, error: completedError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('student_id', student_id)
            .eq('payment_status', 'paid')
            .eq('payment_status', 'completed');

        if (completedError) {
            logger.error('خطأ في جلب عدد الحجوزات المكتملة:', completedError.message);
        }

        const { count: unreadNotifications, error: unreadError } = await supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', student_id)
            .eq('user_type', 'student')
            .eq('is_read', false);

        if (unreadError) {
            logger.error('خطأ في جلب عدد الإشعارات غير المقروءة:', unreadError.message);
        }

        res.json({
            total_sessions: totalSessions || 0,
            paid_sessions: paidSessions || 0,
            completed_sessions: completedSessions || 0,
            unread_notifications: unreadNotifications || 0
        });
    } catch (error) {
        logger.error('خطأ في جلب إحصائيات الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب حالة البث للطالب
// ============================================================
router.get('/stream-status/:offer_id/:student_id', authenticate, authorize(['student']), [
    param('offer_id').isInt().withMessage('معرف الدرس غير صالح'),
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const student_id = parseInt(req.params.student_id);

        if (Number(req.user.userId) !== Number(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.json({ can_join: false, error: 'الدرس غير موجود' });
        }

        let { data: session } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .in('payment_status', ['paid', 'pending_stream'])
            .maybeSingle();

        if (!session && offer) {
            session = await autoBookFreeSession(offer, student_id);
        }

        if (!session) {
            return res.json({ can_join: false, error: 'لم تقم بحجز هذه الحصة' });
        }

        const isLive = offer.status === 'live' || offer.status === 'teacher_ready';
        const isPaused = offer.status === 'paused';
        const isActive = isLive || isPaused;

        res.json({
            can_join: isActive,
            is_waiting: !isActive,
            is_paused: isPaused,
            stream_url: offer.stream_url || null,
            room_password: offer.room_password || null,
            duration: offer.duration || 0,
            status: offer.status,
            subject_name: offer.subject_name,
            teacher_id: offer.teacher_id
        });
    } catch (error) {
        logger.error('خطأ في جلب حالة البث للطالب:', error.message);
        res.status(500).json({ can_join: false, error: error.message });
    }
});

// ============================================================
// ✅ تقييم أستاذ - Rate Teacher
// ============================================================
router.post('/rate-teacher', authenticate, authorize(['student']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('rating').isInt({ min: 1, max: 5 }).withMessage('التقييم يجب أن يكون بين 1 و 5'),
    body('review').optional().isString().trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const student_id = req.user.userId;
        const { teacher_id, rating, review } = req.body;

        // التحقق من وجود الأستاذ
        const { data: teacher, error: teacherError } = await supabase
            .from('teachers')
            .select('id')
            .eq('id', teacher_id)
            .single();

        if (teacherError || !teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        // إضافة أو تحديث التقييم (upsert)
        const { data, error } = await supabase
            .from('teacher_ratings')
            .upsert({
                teacher_id,
                student_id,
                rating,
                review: review || null
            }, { onConflict: 'teacher_id,student_id' })
            .select();

        if (error) {
            logger.error('خطأ أثناء حفظ التقييم:', error.message);
            return res.status(500).json({ success: false, error: 'حدث خطأ أثناء حفظ التقييم' });
        }
        
        // إرسال إشعار للأستاذ
        try {
            const st = await getOne('students', 'id', student_id);
            const studentName = st?.full_name || st?.name || 'طالب';
            await supabase.from('notifications').insert({
                user_id: teacher_id,
                user_type: 'teacher',
                title: '⭐ تقييم جديد',
                message: `قام ${studentName} بتقييمك بـ ${rating} نجوم.${review ? ' المراجعة: ' + review.substring(0, 50) : ''}`,
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (notifErr) {
            console.warn('⚠️ خطأ في إرسال إشعار التقييم:', notifErr.message);
        }

        res.json({ success: true, message: 'تم حفظ تقييمك بنجاح', data });
    } catch (error) {
        logger.error('خطأ في مسار التقييم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
