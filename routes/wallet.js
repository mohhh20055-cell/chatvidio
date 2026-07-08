// ============================================================
// مسارات المحفظة - Wallet Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const crypto = require('crypto');
const axios = require('axios');
const https = require('https');

// استيراد الدوال المساعدة
const { supabase } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');

const CHARGILY_API_KEY = process.env.CHARGILY_API_KEY;
const CHARGILY_API_URL = process.env.CHARGILY_API_URL || 'https://pay.chargily.net/api/v2';
const CHARGILY_WEBHOOK_SECRET = process.env.CHARGILY_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');

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
                        process.env.RENDER_EXTERNAL_URL || 
                        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
                        'https://chatvidio.vercel.app';

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
// Webhook Chargily
// ============================================================
router.post('/chargily-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-signature'];
        
        if (!signature) {
            return res.status(401).json({ success: false, error: 'توقيع غير موجود' });
        }

        const webhookData = req.body;

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
