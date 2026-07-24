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

// ============================================================
// إنشاء طلب دفع عبر SofizPay
// ============================================================
async function createSofizPayTransaction(amount, fullName, phone, email, description, returnUrl, internalTxId) {
    try {
        let finalAmount = Math.max(Number(amount), 100);
        finalAmount = Math.min(finalAmount, 1000000);
        finalAmount = Math.round(finalAmount);

        const memo = description ? `${description} | ref:${internalTxId}` : `ref:${internalTxId}`;

        const params = new URLSearchParams({
            account: SOFIZPAY_ACCOUNT,
            amount: finalAmount.toString(),
            full_name: fullName || 'Student',
            phone: phone || '',
            email: email || '',
            return_url: returnUrl,
            memo: memo,
            redirect: 'yes',
            keep_return_url: 'True'
        });

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        if (SOFIZPAY_SECRET_KEY) {
            headers['Authorization'] = `Bearer ${SOFIZPAY_SECRET_KEY}`;
        }

        const response = await axios.get(`${SOFIZPAY_API_URL}/make-cib-transaction/?${params.toString()}`, {
            headers,
            timeout: 30000,
            httpsAgent: new https.Agent({ keepAlive: true })
        });

        if (response?.data?.payment_url) {
            return {
                success: true,
                payment_url: response.data.payment_url,
                sofizpay_transaction_id: response.data.transaction_id,
                cib_transaction_id: response.data.cib_transaction_id,
                amount: finalAmount,
                status: response.data.status
            };
        }

        throw new Error(response?.data?.message || 'استجابة غير صالحة من SofizPay');
    } catch (error) {
        console.error('❌ خطأ SofizPay:', error.response?.data || error.message);
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
        console.error('❌ خطأ في فحص حالة المعاملة SofizPay:', error.response?.data || error.message);
        return { success: false, error: error.message };
    }
}

// ============================================================
// شحن الرصيد
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

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بشحن رصيد هذا الحساب' });
        }

        const student = await getOne('students', 'id', student_id);
        if (!student) {
            return res.status(404).json({ success: false, error: 'الطالب غير موجود' });
        }

        const finalAmount = Math.round(Math.max(Number(amount), 100));

        const transaction = await insert('wallet_transactions', {
            student_id: student_id,
            amount: finalAmount,
            type: 'deposit',
            status: 'pending',
            description: `طلب شحن رصيد بقيمة ${finalAmount} دج`,
            created_at: new Date().toISOString()
        });

        const baseUrl = process.env.PLATFORM_URL ||
                        (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');

        const returnUrl = `${baseUrl}/api/wallet/sofizpay-callback?txn=${transaction.id}`;

        const checkout = await createSofizPayTransaction(
            finalAmount,
            student.full_name,
            student.phone,
            student.email,
            `شحن رصيد منصة التعليم - ${finalAmount} دج`,
            returnUrl,
            transaction.id
        );

        if (checkout.success && checkout.payment_url) {
            await update('wallet_transactions', transaction.id, {
                sofizpay_transaction_id: checkout.sofizpay_transaction_id,
                cib_transaction_id: checkout.cib_transaction_id
            });

            return res.json({
                success: true,
                checkout_url: checkout.payment_url,
                transaction_id: transaction.id,
                amount: finalAmount
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
        console.error('❌ خطأ في شحن الرصيد:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ داخلي في الخادم' });
    }
});

// ============================================================
// جلب رصيد الطالب ومعاملاته (مع الرصيد المعلق)
// ============================================================
router.get('/balance/:student_id', authenticate, authorize(['student']), async (req, res) => {
    try {
        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
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
            console.error('خطأ في جلب المعاملات:', transactionsError.message);
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
        console.error('❌ خطأ في جلب الرصيد:', error.message);
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
        console.error('❌ خطأ في معالجة كولباك SofizPay:', error.message);
        res.redirect(`/student-dashboard.html?status=error`);
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
        console.error('❌ خطأ في معالجة نجاح الدفع:', error.message);
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
        console.error('❌ خطأ في معالجة فشل الدفع:', error.message);
        res.redirect('/student-dashboard.html');
    }
});

// ============================================================
// جلب سجل معاملات الطالب
// ============================================================
router.get('/transactions/:student_id', authenticate, authorize(['student']), async (req, res) => {
    try {
        const student_id = parseInt(req.params.student_id);

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data: transactions, error } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('student_id', student_id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('خطأ في جلب المعاملات:', error.message);
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
        console.error('❌ خطأ في جلب المعاملات:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// دوال عرض الصفحات
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
