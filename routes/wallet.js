const logger = require('../utils/logger');
// ============================================================
// مسارات المحفظة - Wallet Routes (معدل بالكامل مع دعم الرصيد المعلق)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const crypto = require('crypto');
const axios = require('axios');
const https = require('https');

const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');
const { uploadToSupabase } = require('../utils/upload');
const multer = require('multer');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit for receipt images
});

const defaultCcpSettings = {
    ccp_account_number: "0022334455",
    ccp_key: "45",
    ccp_rip: "00799999002233445545",
    ccp_account_holder: "منصة ZoomDz التعليمية",
    baridimob_phone: "0555001122",
    instructions: "يرجى تحويل المبلغ بدقة عبر تطبيق BaridiMob أو مكتب البريد، ثم إرفاق صورة واضحة لوصل المعاملة ليتم تزويدك بالرصيد فور التأكد من التحويل."
};

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

const SOFIZPAY_API_URL = process.env.SOFIZPAY_API_URL || 'https://sofizpay.com';
const SOFIZPAY_ACCOUNT = process.env.SOFIZPAY_ACCOUNT;
const SOFIZPAY_SECRET_KEY = process.env.SOFIZPAY_SECRET_KEY;
const SOFIZPAY_TRANSACTION_CHECK_URL = process.env.SOFIZPAY_TRANSACTION_CHECK_URL || 'https://sofizpay.com/sep24/transaction/check/';

const CHARGILY_SECRET_KEY = process.env.CHARGILY_SECRET_KEY || 'live_sk_0gRmUvd2hCW1x5stuyzmMHhaB274nigiCZdySO9b';
const CHARGILY_PUBLIC_KEY = process.env.CHARGILY_PUBLIC_KEY || 'live_pk_FeA11LZaYCCFdHGtgfyrq2XcnYEtTba7HoXogcKr';

if (!SOFIZPAY_ACCOUNT) {
    console.warn('⚠️ SOFIZPAY_ACCOUNT غير مضبوط. تأكد من إعداد متغيرات البيئة الخاصة بـ SofizPay.');
}

// ============================================================
// إنشاء طلب دفع عبر Chargily Pay
// ============================================================
async function createChargilyCheckout(amount, returnUrl, transactionId) {
    try {
        let finalAmount = Math.round(Number(amount));
        finalAmount = Math.max(finalAmount, 100); // الحد الأدنى للشحن 100 دج
        finalAmount = Math.min(finalAmount, 1000000);

        // نقوم بإنشاء رابط الدفع لـ Chargily Pay V2
        const payload = {
            amount: finalAmount,
            currency: 'dzd',
            success_url: returnUrl,
            failure_url: returnUrl,
            webhook_endpoint: 'https://zoomdz.com/api/wallet/chargily-webhook',
            metadata: {
                transaction_id: transactionId.toString()
            }
        };

        const response = await axios.post('https://pay.chargily.net/api/v2/checkouts', payload, {
            headers: {
                'Authorization': `Bearer ${CHARGILY_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        if (response.data && response.data.checkout_url) {
            return {
                success: true,
                payment_url: response.data.checkout_url,
                checkout_id: response.data.id,
                amount: finalAmount
            };
        }

        throw new Error('لم يتم استرجاع رابط الدفع من شارجيلي');
    } catch (error) {
        logger.error('❌ خطأ في إنشاء رابط دفع Chargily:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.message || 'حدث خطأ في عملية الدفع'
        };
    }
}

async function checkSofizPayTransactionStatus(cibTransactionId) {
    try {
        const url = `${SOFIZPAY_TRANSACTION_CHECK_URL}?transaction_id=${encodeURIComponent(cibTransactionId)}`;
        const headers = { 'Accept': 'application/json' };
        if (SOFIZPAY_SECRET_KEY) {
            headers['Authorization'] = `Bearer ${SOFIZPAY_SECRET_KEY}`;
        }
        const response = await axios.get(url, { headers, timeout: 30000 });
        return response.data;
    } catch (error) {
        logger.error('❌ خطأ في فحص حالة المعاملة SofizPay:', error.response?.data || error.message);
        return { success: false, error: error.message };
    }
}

// ============================================================
// شحن الرصيد عبر بوابة Chargily Pay
// ============================================================
router.post('/deposit', authenticate, authorize(['student']), [
    body('student_id').isInt().withMessage('معرف الطالب غير صالح'),
    body('amount').isInt({ min: 100, max: 1000000 }).withMessage('المبلغ يجب أن يكون بين 100 و 1,000,000 دج')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { student_id, amount } = req.body;

        if (Number(req.user.userId) !== Number(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بشحن رصيد هذا الحساب' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        const finalAmount = Math.round(Math.max(Number(amount), 100));
        const paymentFee = Math.round(finalAmount * 0.01);
        const totalCharged = finalAmount + paymentFee;

        const transaction = await insert('wallet_transactions', {
            student_id: student_id,
            amount: finalAmount,
            type: 'deposit',
            status: 'pending',
            description: `طلب شحن رصيد بقيمة ${finalAmount} دج (+ 1% رسوم دفع: ${paymentFee} دج | الإجمالي المسدد: ${totalCharged} دج)`,
            created_at: new Date().toISOString()
        });

        if (!transaction || !transaction.id) {
            logger.error('❌ فشل إنشاء سجل المعاملة في قاعدة البيانات:', { student_id, amount: finalAmount });
            return res.status(500).json({ success: false, error: 'فشل إنشاء سجل المعاملة. يرجى المحاولة لاحقاً.' });
        }

        const baseUrl = process.env.PLATFORM_URL ||
                        (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');

        const returnUrl = `${baseUrl}/student-dashboard.html?status=completed`;

        console.log('ℹ️ جاري إنشاء طلب دفع Chargily:', { transaction_id: transaction.id, amount: finalAmount, fee: paymentFee, totalCharged });

        const checkout = await createChargilyCheckout(
            totalCharged,
            returnUrl,
            transaction.id
        );

        if (checkout.success && checkout.payment_url) {
            try {
                await update('wallet_transactions', transaction.id, {
                    sofizpay_transaction_id: checkout.checkout_id || null,
                    cib_transaction_id: checkout.checkout_id || null
                });
            } catch (updateError) {
                console.warn('⚠️ تنبيه: فشل تحديث أعمدة المعاملة في قاعدة البيانات:', updateError.message);
            }

            return res.json({
                success: true,
                checkout_url: checkout.payment_url,
                transaction_id: transaction.id,
                amount: finalAmount,
                fee: paymentFee,
                total_charged: totalCharged
            });
        } else {
            await update('wallet_transactions', transaction.id, {
                status: 'failed',
                description: `فشل إنشاء رابط الدفع: ${checkout.error}`
            });

            return res.status(400).json({
                success: false,
                error: checkout.error || 'حدث خطأ في عملية الدفع، يرجى المحاولة مرة أخرى'
            });
        }
    } catch (error) {
        logger.error('❌ خطأ في شحن الرصيد:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ داخلي في الخادم' });
    }
});

// ============================================================
// شحن الرصيد للأستاذ عبر بوابة Chargily Pay
// ============================================================
router.post('/deposit-teacher', authenticate, authorize(['teacher']), [
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('amount').isInt({ min: 100, max: 1000000 }).withMessage('المبلغ يجب أن يكون بين 100 و 1,000,000 دج')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { teacher_id, amount } = req.body;

        if (Number(req.user.userId) !== Number(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بشحن رصيد هذا الحساب' });
        }

        const teacher = await getOne('teachers', 'id', teacher_id);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        const finalAmount = Math.round(Math.max(Number(amount), 100));
        const paymentFee = Math.round(finalAmount * 0.01);
        const totalCharged = finalAmount + paymentFee;

        const transaction = await insert('wallet_transactions', {
            teacher_id: teacher_id,
            amount: finalAmount,
            type: 'deposit',
            status: 'pending',
            description: `طلب شحن رصيد بقيمة ${finalAmount} دج للأستاذ (+ 1% رسوم دفع: ${paymentFee} دج | الإجمالي المسدد: ${totalCharged} دج)`,
            created_at: new Date().toISOString()
        });

        if (!transaction || !transaction.id) {
            logger.error('❌ فشل إنشاء سجل المعاملة في قاعدة البيانات للأستاذ:', { teacher_id, amount: finalAmount });
            return res.status(500).json({ success: false, error: 'فشل إنشاء سجل المعاملة. يرجى المحاولة لاحقاً.' });
        }

        const baseUrl = process.env.PLATFORM_URL ||
                        (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');

        const returnUrl = `${baseUrl}/teacher-dashboard.html?status=completed`;

        console.log('ℹ️ جاري إنشاء طلب دفع Chargily للأستاذ:', { transaction_id: transaction.id, amount: finalAmount, fee: paymentFee, totalCharged });

        const checkout = await createChargilyCheckout(
            totalCharged,
            returnUrl,
            transaction.id
        );

        if (checkout.success && checkout.payment_url) {
            try {
                await update('wallet_transactions', transaction.id, {
                    sofizpay_transaction_id: checkout.checkout_id || null,
                    cib_transaction_id: checkout.checkout_id || null
                });
            } catch (updateError) {
                console.warn('⚠️ تنبيه: فشل تحديث أعمدة المعاملة للأستاذ في قاعدة البيانات:', updateError.message);
            }

            return res.json({
                success: true,
                checkout_url: checkout.payment_url,
                transaction_id: transaction.id,
                amount: finalAmount,
                fee: paymentFee,
                total_charged: totalCharged
            });
        } else {
            await update('wallet_transactions', transaction.id, {
                status: 'failed',
                description: `فشل إنشاء رابط الدفع: ${checkout.error}`
            });

            return res.status(400).json({
                success: false,
                error: checkout.error || 'فشل إنشاء رابط الدفع'
            });
        }
    } catch (error) {
        logger.error('❌ خطأ في شحن رصيد الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// 🏦 جلب معلومات حساب بريدي موب و CCP للمنصة (لإظهارها للمستخدم)
// ============================================================
router.get('/ccp-info', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('platform_settings')
            .select('value')
            .eq('key', 'ccp_settings')
            .maybeSingle();

        if (!error && data && data.value) {
            return res.json({ 
                success: true, 
                settings: { ...defaultCcpSettings, ...data.value } 
            });
        }
    } catch (e) {
        logger.warn('⚠️ تعذر جلب ccp_settings من قاعدة البيانات:', e.message);
    }
    return res.json({ success: true, settings: defaultCcpSettings });
});

// ============================================================
// 📝 تقديم طلب شحن يدوي عبر بريدي موب / CCP مع رفع وصل المعاملة
// ============================================================
router.post('/manual-deposit', authenticate, upload.single('receipt'), async (req, res) => {
    try {
        const userId = Number(req.user.userId);
        const userType = req.user.role === 'teacher' ? 'teacher' : 'student';
        const amount = parseFloat(req.body.amount);
        const notes = req.body.notes || '';
        let receiptUrl = req.body.receipt_url || '';

        if (!amount || isNaN(amount) || amount < 100) {
            return res.status(400).json({ success: false, error: 'المبلغ المطلوب شحنه يجب أن لا يقل عن 100 دج' });
        }

        // معالجة رفع صورة الوصل
        if (req.file) {
            const uploadRes = await uploadToSupabase(req.file, 'deposit_receipts');
            if (uploadRes && uploadRes.url) {
                receiptUrl = uploadRes.url;
            } else {
                return res.status(400).json({ success: false, error: 'فشل في رفع صورة وصل الدفع. يرجى المحاولة مرة أخرى بصورة واضحة.' });
            }
        }

        if (!receiptUrl) {
            return res.status(400).json({ success: false, error: 'يرجى إرفاق صورة واضحة لوصل الدفع أو لقطة شاشة المعاملة' });
        }

        // جلب معلومات المستخدم لتوثيقها في الطلب
        let userName = '';
        let userEmail = '';
        let userPhone = '';

        if (userType === 'student') {
            const student = await getOne('students', 'id', userId);
            if (student) {
                userName = student.full_name || '';
                userEmail = student.email || '';
                userPhone = student.phone || '';
            }
        } else {
            const teacher = await getOne('teachers', 'id', userId);
            if (teacher) {
                userName = teacher.full_name || '';
                userEmail = teacher.email || '';
                userPhone = teacher.phone || '';
            }
        }

        // 1. تسجيل الطلب في جدول manual_deposit_requests
        let depositRequest = null;
        try {
            const { data, error } = await supabase
                .from('manual_deposit_requests')
                .insert({
                    user_id: userId,
                    user_type: userType,
                    user_name: userName,
                    user_email: userEmail,
                    user_phone: userPhone,
                    amount: amount,
                    receipt_url: receiptUrl,
                    notes: notes,
                    status: 'pending',
                    created_at: new Date().toISOString()
                })
                .select();

            if (!error && data && data.length > 0) {
                depositRequest = data[0];
            } else if (error) {
                logger.warn('⚠️ تنبيه: تعذر إدراج الطلب في manual_deposit_requests:', error.message);
            }
        } catch (dbErr) {
            logger.error('❌ خطأ في إدراج طلب الشحن اليدوي:', dbErr.message);
        }

        // 2. تسجيل معاملة معلقة في جدول wallet_transactions
        try {
            await insert('wallet_transactions', {
                [userType === 'teacher' ? 'teacher_id' : 'student_id']: userId,
                amount: amount,
                type: 'deposit_manual',
                status: 'pending',
                description: `طلب شحن يدوي (بريدي موب / CCP) بقيمة ${amount} دج - في انتظار مراجعة الإدارة`,
                created_at: new Date().toISOString()
            });
        } catch (txErr) {
            logger.warn('⚠️ تنبيه: تعذر إدراج المعاملة في wallet_transactions:', txErr.message);
        }

        // 3. إرسال إشعار للمستخدم
        try {
            await insert('notifications', {
                user_id: userId,
                user_type: userType,
                title: 'تم استلام طلب الشحن بنجاح ⏳',
                content: `تم استلام طلب شحن رصيدك عبر بريدي موب بمبلغ ${amount} دج وهو الآن قيد مراجعة الإدارة وسيتم إضافة الرصيد إلى حسابك فور التحقق.`,
                type: 'wallet',
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (notifErr) {}

        // 4. إشعار للمدير في admin_notifications
        try {
            await supabase.from('admin_notifications').insert({
                title: '📥 طلب شحن رصيد جديد (بريدي موب / CCP)',
                message: `قام ${userType === 'teacher' ? 'الأستاذ' : 'الطالب'} ${userName || `#${userId}`} بطلب شحن رصيد بمبلغ ${amount} دج مع إرفاق وصل التحويل.`,
                type: 'deposit_request',
                reference_id: depositRequest?.id || userId,
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (adminNotifErr) {}

        return res.json({
            success: true,
            message: 'تم إرسال طلب الشحن بنجاح! سيتم التحقق من الوصل وإضافة الرصيد إلى حسابك قريباً.',
            request: depositRequest
        });
    } catch (error) {
        logger.error('❌ خطأ غير متوقع في معالجة طلب الشحن اليدوي:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء إرسال طلب الشحن' });
    }
});

// ============================================================
// جلب معاملات الأستاذ
// ============================================================
router.get('/transactions-teacher/:teacher_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);

        if (Number(req.user.userId) !== Number(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // 1. جلب معاملات الشحن للأستاذ
        const { data: transactions, error } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('خطأ في جلب معاملات الأستاذ:', error.message);
            return res.status(500).json({ success: false, error: error.message });
        }

        // 2. جلب طلبات السحب للأستاذ
        const { data: withdrawals, error: withError } = await supabase
            .from('withdraw_requests')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('created_at', { ascending: false });

        let withdrawalTransactions = [];
        if (!withError && withdrawals) {
            withdrawalTransactions = withdrawals.map(w => ({
                id: w.id,
                amount: w.amount || 0,
                type: 'withdraw',
                status: w.status,
                description: `سحب رصيد | ${w.description || 'طلب سحب'}`,
                created_at: w.created_at
            }));
        }

        // دمج وترتيب المعاملات
        const allTransactions = [...(transactions || []), ...withdrawalTransactions];
        allTransactions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        const teacher = await getOne('teachers', 'id', teacher_id);

        res.json({
            success: true,
            balance: teacher ? (teacher.balance || 0) : 0,
            transactions: allTransactions
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب معاملات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// جلب رصيد الطالب ومعاملاته (مع الرصيد المعلق)
// ============================================================
router.get('/balance/:student_id', authenticate, authorize(['student']), async (req, res) => {
    try {
        const student_id = parseInt(req.params.student_id);

        if (Number(req.user.userId) !== Number(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        // ✅ جلب معاملات المحفظة
        const { data: transactions, error: transactionsError } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('student_id', student_id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (transactionsError) {
            logger.error('خطأ في جلب المعاملات:', transactionsError.message);
        }

        // ✅ جلب الرصيد المعلق من الحجوزات
        const { data: pendingSessions, error: pendingError } = await supabase
            .from('sessions')
            .select('payment_amount, payment_status')
            .eq('student_id', student_id)
            .eq('payment_status', 'pending_stream');

        let totalPendingBalance = 0;
        if (!pendingError && pendingSessions) {
            totalPendingBalance = pendingSessions.reduce((sum, s) => sum + (s.payment_amount || 0), 0);
        }

        // ✅ جلب المبلغ المعلق في معاملات المحفظة
        const { data: pendingTransactions, error: pendingTransError } = await supabase
            .from('wallet_transactions')
            .select('amount')
            .eq('student_id', student_id)
            .eq('status', 'pending_stream');

        if (!pendingTransError && pendingTransactions) {
            const pendingTransAmount = pendingTransactions.reduce((sum, t) => sum + (t.amount || 0), 0);
            totalPendingBalance += pendingTransAmount;
        }

        res.json({
            success: true,
            balance: student.wallet_balance || 0,
            pending_balance: totalPendingBalance,
            total_balance: (student.wallet_balance || 0) - totalPendingBalance,
            transactions: transactions || [],
            gift_box_chances: student.gift_box_chances || 0,
            referral_balance: student.referral_balance || 0
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب الرصيد:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// كولباك SofizPay - معالجة帰還 من منصة الدفع
// ============================================================
router.get('/sofizpay-callback', async (req, res) => {
    try {
        const { txn } = req.query;
        const cibId = req.query.cib_transaction_id || req.query.transaction_id;

        if (!txn) {
            return res.redirect('/student-dashboard.html?status=invalid');
        }

        const transaction = await getOne('wallet_transactions', 'id', txn);
        if (!transaction) {
            return res.redirect(`/student-dashboard.html?status=not_found`);
        }

        if (transaction.status === 'completed') {
            return res.redirect(`/student-dashboard.html?status=completed`);
        }

        if (!cibId && !transaction.cib_transaction_id) {
            return res.redirect(`/student-dashboard.html?status=pending`);
        }

        const targetCibId = cibId || transaction.cib_transaction_id;

        const statusResult = await checkSofizPayTransactionStatus(targetCibId);
        
        let isSuccess = false;
        let statusText = 'pending';

        if (statusResult && (statusResult.status === 'success' || statusResult.data?.status === 'success')) {
            isSuccess = true;
            statusText = 'success';
        } else if (statusResult && (statusResult.status === 'failed' || statusResult.data?.status === 'failed')) {
            statusText = 'failed';
        }

        if (isSuccess) {
            const student = await getOne('students', 'id', transaction.student_id);
            if (student) {
                const currentBalance = parseInt(student.wallet_balance) || 0;
                const addAmount = parseInt(transaction.amount) || 0;
                const newBalance = currentBalance + addAmount;

                await supabase
                    .from('students')
                    .update({ wallet_balance: newBalance })
                    .eq('id', transaction.student_id);

                await update('wallet_transactions', transaction.id, {
                    status: 'completed',
                    description: `تم شحن الرصيد بنجاح بمبلغ ${addAmount} دج`
                });

                await insert('notifications', {
                    user_id: student.id,
                    user_type: 'student',
                    title: '💰 تم شحن الرصيد',
                    message: `تم شحن رصيدك بمبلغ ${addAmount} دج. رصيدك الحالي: ${newBalance} دج`,
                    is_read: false,
                    created_at: new Date().toISOString()
                });

                console.log(`✅ تم تأكيد الدفع SofizPay وإضافة ${addAmount} دج للطالب ${student.full_name}`);
            }
        } else if (statusText === 'failed') {
            await update('wallet_transactions', transaction.id, {
                status: 'failed',
                description: 'فشلت عملية الدفع عبر SofizPay'
            });
        }

        res.redirect(`/student-dashboard.html?status=${isSuccess ? 'paid' : statusText}`);
    } catch (error) {
        logger.error('❌ خطأ في معالجة كولباك SofizPay:', error.message);
        res.redirect(`/student-dashboard.html?status=error`);
    }
});

// ============================================================
// ويب هوك لـ Chargily Pay V2
// ============================================================
router.post('/chargily-webhook', async (req, res) => {
    try {
        const signature = req.headers['signature'];
        if (!signature) {
            logger.error('❌ ويب هوك Chargily: التوقيع مفقود في ترويسة الطلب');
            return res.status(400).json({ success: false, error: 'التوقيع مفقود' });
        }

        // الحصول على محتوى الطلب الخام لعملية التحقق
        const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
        
        // التحقق من صحة التوقيع باستخدام HMAC SHA256
        const computedSignature = crypto
            .createHmac('sha256', CHARGILY_SECRET_KEY)
            .update(rawBody)
            .digest('hex');

        // مقارنة آمنة للوقاية من هجمات التوقيت (Timing Attacks)
        let isSignatureValid = false;
        try {
            isSignatureValid = crypto.timingSafeEqual(
                Buffer.from(signature, 'utf8'),
                Buffer.from(computedSignature, 'utf8')
            );
        } catch (e) {
            isSignatureValid = (signature === computedSignature);
        }

        if (!isSignatureValid) {
            logger.error('❌ ويب هوك Chargily: التوقيع غير متطابق وغير صالح');
            return res.status(401).json({ success: false, error: 'توقيع غير صالح' });
        }

        const event = req.body;
        console.log('📥 ويب هوك Chargily الجديد:', event?.type);

        if (event && event.type === 'checkout.paid') {
            const checkoutData = event.data;
            const metadata = checkoutData?.metadata || {};
            const transactionId = metadata.transaction_id;

            if (!transactionId) {
                logger.error('❌ ويب هوك Chargily: لم يتم العثور على معرف المعاملة في metadata');
                return res.status(400).json({ success: false, error: 'معرف المعاملة مفقود' });
            }

            console.log(`💰 معالجة عملية شحن ناجحة عبر Chargily لـ معاملة رقم ${transactionId}`);

            const transaction = await getOne('wallet_transactions', 'id', transactionId);
            if (!transaction) {
                logger.error(`❌ ويب هوك Chargily: المعاملة رقم ${transactionId} غير موجودة في قاعدة البيانات`);
                return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
            }

            if (transaction.status === 'completed') {
                console.log(`ℹ️ ويب هوك Chargily: المعاملة رقم ${transactionId} مكتملة بالفعل سابقاً`);
                return res.json({ success: true, message: 'مكتملة بالفعل' });
            }

            // Atomic update to prevent race conditions from concurrent webhooks
            const { data: txUpdate, error: txError } = await supabase
                .from('wallet_transactions')
                .update({ status: 'completed' })
                .eq('id', transaction.id)
                .eq('status', 'pending')
                .select();
                
            if (txError || !txUpdate || txUpdate.length === 0) {
                console.log(`ℹ️ ويب هوك Chargily: المعاملة رقم ${transactionId} جاري معالجتها حالياً أو مكتملة`);
                return res.json({ success: true, message: 'جاري المعالجة أو مكتملة' });
            }

            if (transaction.student_id) {
                // تحديث رصيد الطالب في قاعدة البيانات
                const student = await getOne('students', 'id', transaction.student_id);
                if (student) {
                    const currentBalance = parseInt(student.wallet_balance) || 0;
                    const addAmount = parseInt(transaction.amount) || 0;
                    const newBalance = currentBalance + addAmount;

                    await supabase
                        .from('students')
                        .update({ wallet_balance: newBalance })
                        .eq('id', transaction.student_id);

                    await update('wallet_transactions', transaction.id, {
                        status: 'completed',
                        description: `تم شحن الرصيد بنجاح عبر Chargily بمبلغ ${addAmount} دج`
                    });

                    await insert('notifications', {
                        user_id: student.id,
                        user_type: 'student',
                        title: '💰 تم شحن الرصيد بنجاح',
                        message: `تم شحن رصيدك بمبلغ ${addAmount} دج عبر بوابة Chargily Pay. رصيدك الحالي: ${newBalance} دج`,
                        is_read: false,
                        created_at: new Date().toISOString()
                    });

                    console.log(`✅ تم تأكيد شحن الرصيد بنجاح وإضافة ${addAmount} دج للطالب ${student.full_name}`);
                } else {
                    logger.error(`❌ ويب هوك Chargily: الطالب ذو المعرف ${transaction.student_id} غير موجود`);
                }
            } else if (transaction.teacher_id) {
                // تحديث رصيد الأستاذ في قاعدة البيانات
                const teacher = await getOne('teachers', 'id', transaction.teacher_id);
                if (teacher) {
                    const currentBalance = parseFloat(teacher.balance) || 0;
                    const addAmount = parseFloat(transaction.amount) || 0;
                    const newBalance = currentBalance + addAmount;

                    await supabase
                        .from('teachers')
                        .update({ balance: newBalance })
                        .eq('id', transaction.teacher_id);

                    await update('wallet_transactions', transaction.id, {
                        status: 'completed',
                        description: `تم شحن الرصيد بنجاح عبر Chargily بمبلغ ${addAmount} دج`
                    });

                    await insert('notifications', {
                        user_id: teacher.id,
                        user_type: 'teacher',
                        title: '💰 تم شحن الرصيد بنجاح',
                        message: `تم شحن رصيدك بمبلغ ${addAmount} دج عبر بوابة Chargily Pay. رصيدك الحالي: ${newBalance} دج`,
                        is_read: false,
                        created_at: new Date().toISOString()
                    });

                    console.log(`✅ تم تأكيد شحن الرصيد بنجاح وإضافة ${addAmount} دج للأستاذ ${teacher.full_name}`);
                } else {
                    logger.error(`❌ ويب هوك Chargily: الأستاذ ذو المعرف ${transaction.teacher_id} غير موجود`);
                }
            } else {
                logger.error('❌ ويب هوك Chargily: المعاملة لا تملك student_id أو teacher_id');
            }
        }

        res.json({ success: true });
    } catch (error) {
        logger.error('❌ خطأ في معالجة ويب هوك Chargily:', error.message);
        res.status(500).json({ success: false, error: 'خطأ داخلي' });
    }
});

// ============================================================
// نجاح الدفع (قديم - نحتفظ به للتوافق)
// ============================================================
router.get('/deposit/success/:transaction_id', [
    query('token').notEmpty().withMessage('رمز التحقق مطلوب')
], async (req, res) => {
    const { transaction_id } = req.params;
    const { token } = req.query;

    try {
        const expectedToken = crypto.createHash('sha256')
            .update(`${transaction_id}-${process.env.JWT_SECRET || 'zoomdz_webhook_secret_2024'}`)
            .digest('hex');
        
        if (token !== expectedToken) {
            return res.status(403).send(renderErrorPage('طلب غير مصرح به', 'رمز التحقق غير صحيح'));
        }

        const transaction = await getOne('wallet_transactions', 'id', transaction_id);
        if (!transaction) {
            return res.status(404).send(renderErrorPage('خطأ', 'المعاملة غير موجودة'));
        }

        if (transaction.status === 'completed') {
            return res.send(renderSuccessPage('تمت المعاملة', 'تم شحن رصيدك بالفعل', '', 'العودة للوحة', '/student-dashboard.html'));
        }

        if (transaction.status !== 'pending') {
            return res.status(400).send(renderErrorPage('خطأ', 'هذه المعاملة لا يمكن معالجتها'));
        }

        // Atomic update to prevent race conditions
        const { data: txUpdate, error: txError } = await supabase
            .from('wallet_transactions')
            .update({ status: 'completed' })
            .eq('id', transaction.id)
            .eq('status', 'pending')
            .select();
            
        if (txError || !txUpdate || txUpdate.length === 0) {
            return res.send(renderSuccessPage('تمت المعاملة', 'تم شحن رصيدك بالفعل', '', 'العودة للوحة', '/student-dashboard.html'));
        }

        const amount = transaction.amount;
        
        const student = await getOne('students', 'id', transaction.student_id);
        if (!student) {
            return res.status(404).send(renderErrorPage('خطأ', 'الطالب غير موجود'));
        }

        const currentBalance = parseInt(student.wallet_balance) || 0;
        const addAmount = parseInt(amount) || 0;
        const newBalance = currentBalance + addAmount;
        
        await supabase
            .from('students')
            .update({ wallet_balance: newBalance })
            .eq('id', transaction.student_id);

        await update('wallet_transactions', transaction_id, {
            status: 'completed',
            description: `تم شحن الرصيد بنجاح بمبلغ ${amount} دج`
        });

        await insert('notifications', {
            user_id: student.id,
            user_type: 'student',
            title: '💰 تم شحن الرصيد',
            message: `تم شحن رصيدك بمبلغ ${amount} دج. رصيدك الحالي: ${newBalance} دج`,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>تم شحن الرصيد</title>
            <style>
                body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                h1{color:#10b981;font-size:2.5rem}
                .amount{font-size:2rem;font-weight:900;color:#0f5cbf;margin:10px 0}
                .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
                .btn:hover{background:#0a4a9a}
                .sub{color:#666;margin-top:10px}
            </style>
            </head>
            <body>
            <div class="card">
                <h1>✅ تم الشحن بنجاح!</h1>
                <div class="amount">+${amount} دج</div>
                <p style="font-size:1.1rem;">تم إضافة المبلغ إلى رصيدك</p>
                <p class="sub">الرصيد الجديد: ${newBalance} دج</p>
                <a href="/student-dashboard.html" class="btn">العودة للوحة</a>
            </div>
            </body>
            </html>
        `);
    } catch (error) {
        logger.error('❌ خطأ في معالجة نجاح الدفع:', error.message);
        res.status(500).send(renderErrorPage('حدث خطأ', 'حدث خطأ أثناء معالجة الدفع. يرجى التواصل مع الدعم الفني.', '/student-dashboard.html'));
    }
});

// ============================================================
// فشل الدفع (قديم - نحتفظ به للتوافق)
// ============================================================
router.get('/deposit/failure/:transaction_id', async (req, res) => {
    const { transaction_id } = req.params;

    try {
        await update('wallet_transactions', transaction_id, {
            status: 'failed',
            description: 'فشلت عملية الدفع'
        });

        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>فشل الشحن</title>
            <style>
                body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
                .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                h1{color:#f59e0b}
                .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
                .btn:hover{background:#0a4a9a}
            </style>
            </head>
            <body>
            <div class="card">
                <h1>❌ فشل الشحن</h1>
                <p>حدث خطأ أثناء عملية الدفع. لم يتم خصم أي مبلغ من حسابك.</p>
                <a href="/student-dashboard.html" class="btn">المحاولة مرة أخرى</a>
            </div>
            </body>
            </html>
        `);
    } catch (error) {
        logger.error('❌ خطأ في معالجة فشل الدفع:', error.message);
        res.redirect('/student-dashboard.html');
    }
});

// ============================================================
// جلب سجل معاملات الطالب
// ============================================================
router.get('/transactions/:student_id', authenticate, authorize(['student']), async (req, res) => {
    try {
        const student_id = parseInt(req.params.student_id);

        if (Number(req.user.userId) !== Number(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data: transactions, error } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('student_id', student_id)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('خطأ في جلب المعاملات:', error.message);
            return res.status(500).json({ success: false, error: error.message });
        }

        // ✅ إضافة معلومات الرصيد المعلق من الحجوزات
        const { data: pendingSessions, error: pendingError } = await supabase
            .from('sessions')
            .select('id, payment_amount, created_at, offers:offer_id(subject_name)')
            .eq('student_id', student_id)
            .eq('payment_status', 'pending_stream');

        let pendingTransactions = [];
        if (!pendingError && pendingSessions) {
            pendingTransactions = pendingSessions.map(s => ({
                id: s.id,
                amount: s.payment_amount || 0,
                type: 'withdraw_pending',
                status: 'pending_stream',
                description: `حجز حصة "${s.offers?.subject_name || 'غير معروف'}" (في انتظار البث)`,
                created_at: s.created_at
            }));
        }

        // ✅ دمج المعاملات
        const allTransactions = [...(transactions || []), ...pendingTransactions];
        allTransactions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({
            success: true,
            transactions: allTransactions,
            pending_count: pendingTransactions.length
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب المعاملات:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// دوال درس الصفحات
// ============================================================
function renderSuccessPage(title, message, subMessage, buttonText, buttonLink) {
    return `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>${title}</title>
        <style>
            body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
            .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
            h1{color:#10b981;font-size:2.5rem}
            .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
            .btn:hover{background:#0a4a9a}
            .sub{color:#666;margin-top:10px}
        </style>
        </head>
        <body>
        <div class="card">
            <h1>✅ ${title}</h1>
            <p style="font-size:1.2rem;">${message}</p>
            <p class="sub">${subMessage}</p>
            <a href="${buttonLink || '/'}" class="btn">${buttonText || 'العودة للرئيسية'}</a>
        </div>
        </body>
        </html>
    `;
}

function renderErrorPage(title, message, buttonLink) {
    return `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>خطأ</title>
        <style>
            body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;direction:rtl}
            .card{background:white;padding:40px;border-radius:20px;text-align:center;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
            h1{color:#dc2626}
            .btn{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}
        </style>
        </head>
        <body>
        <div class="card">
            <h1>❌ ${title}</h1>
            <p>${message}</p>
            <a href="${buttonLink || '/'}" class="btn">العودة للرئيسية</a>
        </div>
        </body>
        </html>
    `;
}

module.exports = router;
