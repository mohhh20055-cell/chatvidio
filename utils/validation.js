// ============================================================
// دوال التحقق
// ============================================================

const axios = require('axios');

const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY;

async function verifyRecaptcha(token) {
    if (!RECAPTCHA_SECRET_KEY) {
        console.error('❌ مفتاح reCAPTCHA السري غير موجود');
        return { success: false, error: 'مفتاح reCAPTCHA غير مضبوط' };
    }

    if (!token) {
        return { success: false, error: 'رمز reCAPTCHA مطلوب' };
    }

    try {
        const response = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            null,
            {
                params: {
                    secret: RECAPTCHA_SECRET_KEY,
                    response: token
                },
                timeout: 10000
            }
        );

        const data = response.data;

        if (data.success) {
            return { success: true };
        } else {
            console.error('❌ فشل التحقق من reCAPTCHA:', data['error-codes'] || 'خطأ غير معروف');
            return { 
                success: false, 
                error: 'فشل التحقق من أنك لست روبوتاً. يرجى المحاولة مرة أخرى.'
            };
        }
    } catch (error) {
        console.error('❌ خطأ في الاتصال بـ reCAPTCHA:', error.message);
        return { 
            success: false, 
            error: 'حدث خطأ في التحقق من reCAPTCHA. يرجى المحاولة مرة أخرى.'
        };
    }
}

module.exports = {
    verifyRecaptcha
};
