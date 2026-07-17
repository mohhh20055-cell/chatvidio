// ============================================================
// دوال التحقق
// ============================================================

const axios = require('axios');
const https = require('https');

const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY;

async function verifyRecaptcha(token) {
    // التحقق من وجود المفتاح السري
    if (!RECAPTCHA_SECRET_KEY) {
        console.error('❌ خطأ: مفتاح reCAPTCHA السري (RECAPTCHA_SECRET_KEY) غير موجود في متغيرات البيئة');
        return { 
            success: false, 
            error: 'خطأ في إعدادات الخادم - يرجى التحقق من متغيرات البيئة'
        };
    }

    // التحقق من وجود الرمز
    if (!token || token.trim() === '') {
        console.warn('⚠️ رمز reCAPTCHA فارغ أو غير موجود');
        return { 
            success: false, 
            error: 'رمز reCAPTCHA مطلوب. يرجى إكمال التحقق أولاً.'
        };
    }

    try {
        console.log('🔄 جاري التحقق من reCAPTCHA...');
        
        const response = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            null,
            {
                params: {
                    secret: RECAPTCHA_SECRET_KEY,
                    response: token
                },
                timeout: 10000,
                // لحل مشاكل SSL في بعض الحالات
                httpsAgent: new https.Agent({
                    rejectUnauthorized: false
                })
            }
        );

        const data = response.data;

        // التحقق من نجاح التحقق
        if (data.success) {
            console.log('✅ تم التحقق من reCAPTCHA بنجاح - Score:', data.score || 'N/A');
            return { 
                success: true,
                score: data.score
            };
        } else {
            const errorCodes = data['error-codes'] || ['unknown'];
            console.error('❌ فشل التحقق من reCAPTCHA - Error codes:', errorCodes);
            
            // معالجة أخطاء محددة
            if (errorCodes.includes('timeout-or-duplicate')) {
                return { 
                    success: false, 
                    error: 'انتهت مهلة التحقق. يرجى المحاولة مرة أخرى.'
                };
            }
            
            return { 
                success: false, 
                error: 'فشل التحقق من أنك لست روبوتاً. يرجى المحاولة مرة أخرى.'
            };
        }
    } catch (error) {
        console.error('❌ خطأ في الاتصال بـ Google reCAPTCHA:', {
            message: error.message,
            code: error.code,
            status: error.response?.status
        });

        // توفير رسائل خطأ مفيدة بناءً على نوع الخطأ
        if (error.code === 'ECONNREFUSED') {
            return { 
                success: false, 
                error: 'خطأ في الاتصال. تأكد من اتصال الانترنت.'
            };
        }

        if (error.code === 'ETIMEDOUT') {
            return { 
                success: false, 
                error: 'انتهت مهلة الاتصال. يرجى المحاولة مرة أخرى.'
            };
        }

        return { 
            success: false, 
            error: 'حدث خطأ في التحقق من reCAPTCHA. يرجى المحاولة لاحقاً.'
        };
    }
}

module.exports = {
    verifyRecaptcha
};
