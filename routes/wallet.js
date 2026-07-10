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

const CHARGILY_API_KEY = process.env.CHARGILY_API_KEY;
const CHARGILY_API_URL = process.env.CHARGILY_API_URL || 'https://pay.chargily.net/api/v2';
const CHARGILY_WEBHOOK_SECRET = process.env.CHARGILY_WEBHOOK_SECRET || process.env.JWT_SECRET || 'zoomdz_webhook_secret_2024';

// ============================================================
// إنشاء طلب شحن عبر Chargily
// ============================================================
async function createChargilyCheckout(amount, studentName, studentEmail, studentPhone, description, successUrl, failureUrl) {
    try {
        let finalAmount = Math.max(Number(amount), 50);
        finalAmount = Math.min(finalAmount, 1000000);
        finalAmount = Math.round(finalAmount);

        const checkoutData = {
            amount: finalAmount,
            currency: 'dzd',
            success_url: successUrl,
            failure_url: failureUrl,
            locale: 'ar',
            description: description || `شحن رصيد بقيمة ${finalAmount} دج`,
            metadata: {
                student_name: studentName || 'طالب',
                student_email: studentEmail || '',
                type: 'wallet_deposit',
                timestamp: Date.now().toString()
            }
        };

        const authMethods = [
            { 'Authorization': `Bearer ${CHARGILY_API_KEY}` },
            { 'X-Authorization': CHARGILY_API_KEY },
            { 'Api-Key': CHARGILY_API_KEY }
        ];

        let lastError = null;

        for (let i = 0; i < authMethods.length; i++) {
            try {
                const response = await axios.post(`${CHARGILY_API_URL}/checkouts`, checkoutData, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        ...authMethods[i]
                    },
                    timeout: 30000,
                    httpsAgent: new https.Agent({ keepAlive: true })
                });

                if (response?.data?.checkout_url) {
                    return {
                        success: true,
                        checkout_url: response.data.checkout_url,
                        checkout_id: response.data.id,
                        amount: finalAmount
                    };
                }
            } catch (error) {
                lastError = error;
                if (i < authMethods.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        throw new Error(lastError?.response?.data?.message || lastError?.message || 'فشلت جميع محاولات الدفع');
    } catch (error) {
        console.error('❌ خطأ Chargily:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.message || 'حدث خطأ في عملية الدفع'
        };
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

        const successToken = crypto.createHash('sha256')
            .update(`${transaction.id}-${CHARGILY_WEBHOOK_SECRET}`)
            .digest('hex');
        
        const successUrl = `${baseUrl}/api/wallet/deposit/success/${transaction.id}?token=${successToken}`;
        const failureUrl = `${baseUrl}/api/wallet/deposit/failure/${transaction.id}`;

        const checkout = await createChargilyCheckout(
            finalAmount,
            student.full_name,
            student.email,
            student.phone,
            `شحن رصيد منصة التعليم - ${finalAmount} دج`,
            successUrl,
            failureUrl
        );

        if (checkout.success && checkout.checkout_url) {
            await update('wallet_transactions', transaction.id, { 
                chargily_checkout_id: checkout.checkout_id 
            });
            
            return res.json({
                success: true,
                checkout_url: checkout.checkout_url,
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
// Webhook Chargily
// ============================================================
router.post('/chargily-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-signature'];

        if (!signature) {
            return res.status(401).json({ success: false, error: 'توقيع غير موجود' });
        }

        const rawBody = req.body;
        let payloadBuffer;
        let webhookData;

        if (Buffer.isBuffer(rawBody)) {
            payloadBuffer = rawBody;
            webhookData = JSON.parse(rawBody.toString('utf8'));
        } else if (typeof rawBody === 'string') {
            payloadBuffer = Buffer.from(rawBody, 'utf8');
            webhookData = JSON.parse(rawBody);
        } else {
            webhookData = rawBody;
            payloadBuffer = Buffer.from(JSON.stringify(rawBody), 'utf8');
        }

        // ✅ التحقق من التوقيع إذا كان السر موجوداً
        const expectedSignature = crypto
            .createHmac('sha256', CHARGILY_WEBHOOK_SECRET)
            .update(payloadBuffer)
            .digest('hex');

        if (signature !== expectedSignature) {
            console.log('⚠️ توقيع Chargily غير متطابق، قد يكون هناك خلاف في إعدادات Webhook Secret');
        }

        if (webhookData.event === 'checkout.paid') {
            const checkoutId = webhookData.data?.id;
            const metadata = webhookData.data?.metadata || {};

            const { data: transactions } = await supabase
                .from('wallet_transactions')
                .select('*')
                .eq('chargily_checkout_id', checkoutId)
                .eq('status', 'pending');

            if (transactions && transactions.length > 0) {
                const transaction = transactions[0];
                
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

                    // ✅ إرسال إشعار للطالب
                    await insert('notifications', {
                        user_id: student.id,
                        user_type: 'student',
                        title: '💰 تم شحن الرصيد',
                        message: `تم شحن رصيدك بمبلغ ${addAmount} دج. رصيدك الحالي: ${newBalance} دج`,
                        is_read: false,
                        created_at: new Date().toISOString()
                    });

                    console.log(`✅ تم تأكيد الدفع وإضافة ${addAmount} دج للطالب ${student.full_name}`);
                }
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('❌ خطأ في Webhook:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في معالجة الـ Webhook' });
    }
});

// ============================================================
// نجاح الدفع
// ============================================================
router.get('/deposit/success/:transaction_id', [
    query('token').notEmpty().withMessage('رمز التحقق مطلوب')
], async (req, res) => {
    const { transaction_id } = req.params;
    const { token } = req.query;

    try {
        const expectedToken = crypto.createHash('sha256')
            .update(`${transaction_id}-${CHARGILY_WEBHOOK_SECRET}`)
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

        // ✅ إرسال إشعار للطالب
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
// فشل الدفع
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
